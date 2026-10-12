package probe

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	pb "github.com/Songwo/zhiyu/services/probe/proto"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	netstat "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/sensors"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type AgentConfig struct {
	Endpoint        string `json:"endpoint"`
	ID              string `json:"id"`
	Secret          string `json:"secret"`
	IntervalSeconds int    `json:"intervalSeconds"`
	AllowInsecure   bool   `json:"allowInsecure"`
	CAFile          string `json:"caFile,omitempty"`
}

func ReadPrivateFile(path string) ([]byte, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("credential file must be a regular file")
	}
	if st.Size() > 64*1024 {
		return nil, errors.New("credential file too large")
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("credential file permissions must be 0600")
	}
	return os.ReadFile(path)
}
func LoadAgentConfig(path string) (AgentConfig, error) {
	var cfg AgentConfig
	raw, err := ReadPrivateFile(path)
	if err != nil {
		return cfg, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&cfg); err != nil {
		return cfg, errors.New("invalid agent configuration")
	}
	var tail any
	if decoder.Decode(&tail) != io.EOF {
		return cfg, errors.New("agent configuration must contain one JSON value")
	}
	if cfg.IntervalSeconds == 0 {
		cfg.IntervalSeconds = 3
	}
	if _, _, err = cfg.connection(); err != nil {
		return cfg, err
	}
	return cfg, nil
}
func (c AgentConfig) connection() (string, credentials.TransportCredentials, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", nil, errors.New("endpoint must be https://host:port")
	}
	if len(c.ID) == 0 || len(c.ID) > 100 || len(c.Secret) < 32 || len(c.Secret) > 256 {
		return "", nil, errors.New("invalid agent credentials")
	}
	if c.IntervalSeconds < 1 || c.IntervalSeconds > 4 {
		return "", nil, errors.New("report interval must be 1–4 seconds")
	}
	if u.Scheme == "http" && c.AllowInsecure {
		ip, parseErr := netip.ParseAddr(u.Hostname())
		if strings.ToLower(u.Hostname()) != "localhost" && (parseErr != nil || !(ip.IsPrivate() || ip.IsLoopback())) {
			return "", nil, errors.New("plaintext h2c is restricted to localhost or a literal private IP")
		}
		return u.Host, insecure.NewCredentials(), nil
	}
	if u.Scheme != "https" {
		return "", nil, errors.New("TLS is required; local h2c requires http and allowInsecure=true")
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname()}
	if c.CAFile != "" {
		pem, err := os.ReadFile(c.CAFile)
		if err != nil {
			return "", nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return "", nil, errors.New("CA file contains no certificate")
		}
		tlsConfig.RootCAs = pool
	}
	return u.Host, credentials.NewTLS(tlsConfig), nil
}

type Sampler struct {
	previousAt             time.Time
	previousRx, previousTx uint64
	warmed                 bool
}

func ptr(v float64) *float64 { return &v }
func (s *Sampler) Sample(ctx context.Context) *pb.SystemState {
	v := &pb.SystemState{}
	if values, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(values) > 0 && s.warmed {
		v.Cpu = ptr(values[0])
	}
	s.warmed = true
	if info, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		v.Memory = ptr(info.UsedPercent)
		v.MemoryTotal = ptr(float64(info.Total))
	}
	if info, err := mem.SwapMemoryWithContext(ctx); err == nil {
		v.Swap = ptr(info.UsedPercent)
	}
	root := "/"
	if runtime.GOOS == "windows" {
		root = os.Getenv("SystemDrive") + `\`
		if root == `\` {
			root = `C:\`
		}
	}
	if info, err := disk.UsageWithContext(ctx, root); err == nil {
		v.Disk = ptr(info.UsedPercent)
		v.DiskTotal = ptr(float64(info.Total))
	}
	if info, err := netstat.IOCountersWithContext(ctx, false); err == nil && len(info) > 0 {
		now := time.Now()
		rx, tx := info[0].BytesRecv, info[0].BytesSent
		v.NetworkRx = ptr(float64(rx))
		v.NetworkTx = ptr(float64(tx))
		elapsed := now.Sub(s.previousAt).Seconds()
		if !s.previousAt.IsZero() && elapsed > 0 && rx >= s.previousRx && tx >= s.previousTx {
			v.RxRate = ptr(float64(rx-s.previousRx) / elapsed)
			v.TxRate = ptr(float64(tx-s.previousTx) / elapsed)
		}
		s.previousAt = now
		s.previousRx = rx
		s.previousTx = tx
	}
	if seconds, err := host.UptimeWithContext(ctx); err == nil {
		v.Uptime = ptr(float64(seconds))
	}
	if avg, err := load.AvgWithContext(ctx); err == nil {
		v.Load1 = ptr(avg.Load1)
		v.Load5 = ptr(avg.Load5)
		v.Load15 = ptr(avg.Load15)
	}
	if connections, err := netstat.ConnectionsWithContext(ctx, "all"); err == nil {
		tcp, udp := 0, 0
		for _, connection := range connections {
			if connection.Type == 1 {
				tcp++
			} else if connection.Type == 2 {
				udp++
			}
		}
		v.Tcp = ptr(float64(tcp))
		v.Udp = ptr(float64(udp))
	}
	if pids, err := process.PidsWithContext(ctx); err == nil {
		v.Processes = ptr(float64(len(pids)))
	}
	if temperatures, err := sensors.TemperaturesWithContext(ctx); err == nil {
		for _, sensor := range temperatures {
			if sensor.Temperature != 0 && (v.Temperature == nil || sensor.Temperature > *v.Temperature) {
				v.Temperature = ptr(sensor.Temperature)
			}
		}
	}
	return v
}

func RunAgent(ctx context.Context, cfg AgentConfig, onState func(string)) error {
	target, transport, err := cfg.connection()
	if err != nil {
		return err
	}
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(transport), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(16*1024), grpc.MaxCallSendMsgSize(16*1024)))
	if err != nil {
		return err
	}
	defer conn.Close()
	client := pb.NewProbeServiceClient(conn)
	md := metadata.Pairs("client-uuid", cfg.ID, "client-secret", cfg.Secret)
	sampler := &Sampler{}
	delay := time.Second
	for ctx.Err() == nil {
		streamContext, cancel := context.WithCancel(metadata.NewOutgoingContext(ctx, md))
		rpcContext, stop := context.WithTimeout(streamContext, 10*time.Second)
		hostname, _ := os.Hostname()
		_, err := client.ReportSystemInfo(rpcContext, &pb.SystemInfo{Hostname: hostname, Os: runtime.GOOS, Arch: runtime.GOARCH})
		stop()
		if err == nil {
			var stream grpc.BidiStreamingClient[pb.SystemState, pb.Ack]
			stream, err = client.ReportSystemState(streamContext)
			if err == nil {
				onState("connected")
				connectedAt := time.Now()
				err = reportLoop(streamContext, cancel, stream, sampler, time.Duration(cfg.IntervalSeconds)*time.Second)
				if time.Since(connectedAt) > 30*time.Second {
					delay = time.Second
				}
			}
		}
		cancel()
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			onState("disconnected; retrying")
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
	}
	return nil
}
func reportLoop(ctx context.Context, cancel context.CancelFunc, stream grpc.BidiStreamingClient[pb.SystemState, pb.Ack], sampler *Sampler, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		sampleCtx, stop := context.WithTimeout(ctx, interval)
		sample := sampler.Sample(sampleCtx)
		stop()
		// 为每次发送和确认设置总时限，断网时不会永久卡在 Recv。
		timeout := time.AfterFunc(10*time.Second, cancel)
		err := stream.Send(sample)
		if err == nil {
			_, err = stream.Recv()
		}
		timeout.Stop()
		if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
