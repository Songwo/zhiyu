package probe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

func deniedIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	return !ip.IsValid() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.String() == "100.100.100.200" || ip.String() == "fd00:ec2::254" || ip == netip.MustParseAddr("255.255.255.255")
}
func safeHost(host string) error {
	name := strings.TrimSuffix(strings.ToLower(host), ".")
	if name == "metadata.google.internal" || name == "metadata.goog" || name == "instance-data" || strings.ContainsAny(name, "%\x00\r\n") {
		return errors.New("metadata and link-local targets are not allowed")
	}
	if ip, err := netip.ParseAddr(name); err == nil && deniedIP(ip) {
		return errors.New("metadata and link-local targets are not allowed")
	}
	return nil
}
func validateCheck(c CheckInput) error {
	if len(c.ID) > 100 || strings.ContainsAny(c.ID, "/\\\x00") || len(strings.TrimSpace(c.Name)) == 0 || utf8.RuneCountInString(c.Name) > 160 {
		return errors.New("invalid check name or id")
	}
	if c.IntervalSeconds < 10 || c.IntervalSeconds > 3600 || c.TimeoutMs < 100 || c.TimeoutMs > 30000 || c.TimeoutMs > c.IntervalSeconds*1000 {
		return errors.New("interval must be 10–3600 seconds; timeout must be 100–30000 ms and not exceed interval")
	}
	if len(c.Target) > 2048 {
		return errors.New("target too long")
	}
	var host string
	switch c.Type {
	case "http":
		u, err := url.Parse(c.Target)
		if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return errors.New("target must be an HTTP(S) URL without embedded credentials or fragment")
		}
		host = u.Hostname()
		if p := u.Port(); p != "" {
			n, e := strconv.Atoi(p)
			if e != nil || n < 1 || n > 65535 {
				return errors.New("invalid target port")
			}
		}
	case "tcp":
		h, p, err := net.SplitHostPort(c.Target)
		if err != nil || h == "" || strings.ContainsAny(h, "/@?#") {
			return errors.New("TCP target must be host:port")
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return errors.New("invalid target port")
		}
		host = h
	default:
		return errors.New("check type must be http or tcp")
	}
	return safeHost(host)
}

func safeDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	if err = safeHost(host); err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, errors.New("no address")
	}
	for _, ip := range addresses {
		if deniedIP(ip) {
			return nil, errors.New("resolved target is not allowed")
		}
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	var last error
	for _, ip := range addresses {
		conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	return nil, last
}
func RunCheck(parent context.Context, check Check) CheckResult {
	start := time.Now()
	result := CheckResult{At: utc(start), Status: "down", Message: "connection failed"}
	if err := validateCheck(check.CheckInput); err != nil {
		result.Message = "invalid or blocked target"
		return result
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(check.TimeoutMs)*time.Millisecond)
	defer cancel()
	if check.Type == "tcp" {
		conn, err := safeDial(ctx, "tcp", check.Target)
		if err != nil {
			if ctx.Err() != nil {
				result.Message = "connection timed out"
			}
			return result
		}
		_ = conn.Close()
		result.Status = "up"
		result.Message = "TCP connected"
	} else {
		transport := &http.Transport{DialContext: safeDial, Proxy: nil, TLSHandshakeTimeout: time.Duration(check.TimeoutMs) * time.Millisecond, ResponseHeaderTimeout: time.Duration(check.TimeoutMs) * time.Millisecond, DisableKeepAlives: true, MaxResponseHeaderBytes: 32 * 1024}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, check.Target, nil)
		if err != nil {
			return result
		}
		req.Header.Set("User-Agent", "Zhiyu-Probe/1")
		response, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				result.Message = "request timed out"
			}
			return result
		}
		defer response.Body.Close()
		// 只检查可达性，最多读取 64 KiB，禁止重定向到内网元数据端点。
		_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		if readErr != nil {
			result.Message = "response read failed"
			return result
		}
		result.Message = fmt.Sprintf("HTTP %d", response.StatusCode)
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			result.Status = "up"
		} else if response.StatusCode >= 300 && response.StatusCode < 400 {
			result.Message += " (redirect not followed)"
		}
	}
	latency := float64(time.Since(start).Microseconds()) / 1000
	result.LatencyMs = &latency
	return result
}

func (s *Server) RunChecks(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	s.runChecks(ctx, ticker.C, RunCheck)
}

func (s *Server) runChecks(ctx context.Context, ticks <-chan time.Time, run func(context.Context, Check) CheckResult) {
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	_ = s.store.Prune(time.Now())
	busy := map[string]bool{}
	next := map[string]time.Time{}
	revisions := map[string]string{}
	var mu sync.Mutex
	var workers sync.WaitGroup
	defer workers.Wait()
	slots := make(chan struct{}, 8)
	for {
		select {
		case <-ctx.Done():
			return
		case <-prune.C:
			_ = s.store.Prune(time.Now())
		case now, open := <-ticks:
			if !open {
				return
			}
			checks, err := s.store.configuredChecks()
			if err != nil {
				continue
			}
			known := map[string]bool{}
			mu.Lock()
			for _, check := range checks {
				known[check.ID] = true
				if revisions[check.ID] != check.Revision {
					next[check.ID] = time.Time{}
					revisions[check.ID] = check.Revision
				}
			}
			// 未执行和等待最久的检查优先，慢任务不能一直抢占前八个槽。
			sort.Slice(checks, func(i, j int) bool {
				a, b := next[checks[i].ID], next[checks[j].ID]
				if a.Equal(b) {
					return checks[i].ID < checks[j].ID
				}
				return a.Before(b)
			})
			mu.Unlock()
			for _, check := range checks {
				mu.Lock()
				skip := busy[check.ID] || now.Before(next[check.ID])
				mu.Unlock()
				if skip {
					continue
				}
				select {
				case slots <- struct{}{}:
				default:
					continue
				}
				mu.Lock()
				busy[check.ID] = true
				next[check.ID] = now.Add(time.Duration(check.IntervalSeconds) * time.Second)
				mu.Unlock()
				workers.Add(1)
				go func(c Check) {
					defer workers.Done()
					defer func() { <-slots; mu.Lock(); delete(busy, c.ID); mu.Unlock() }()
					result := run(ctx, c)
					if ctx.Err() == nil {
						_ = s.store.SaveResult(c, result, time.Now())
					}
				}(check)
			}
			mu.Lock()
			for id := range next {
				if !known[id] {
					delete(next, id)
					delete(revisions, id)
				}
			}
			mu.Unlock()
		}
	}
}
