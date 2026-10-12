package probe

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/Songwo/zhiyu/services/probe/proto"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const testAdmin = "test-admin-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"

func newTestServer(t *testing.T) (*Store, *Server) {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "probe.db"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, testAdmin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Stop(); _ = store.Close() })
	return store, server
}
func httpRequest(t *testing.T, handler http.Handler, method, path, body string, authorized bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if authorized {
		req.Header.Set("Authorization", "Bearer "+testAdmin)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestAdministratorBoundary(t *testing.T) {
	store, server := newTestServer(t)
	for _, token := range []string{"", strings.Repeat("a", 40), "short", testAdmin + "\n"} {
		if _, err := NewServer(store, token); err == nil {
			t.Fatalf("weak token accepted")
		}
	}
	handler := server.Handler(true)
	if rec := httpRequest(t, handler, "GET", "/healthz", "", false); rec.Code != 200 || strings.Contains(rec.Body.String(), "host") {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if rec := httpRequest(t, handler, "GET", "/api/v1/hosts", "", false); rec.Code != 401 {
		t.Fatal(rec.Code)
	}
	req := httptest.NewRequest("GET", "/api/v1/hosts", nil)
	req.Header.Add("Authorization", "Bearer "+testAdmin)
	req.Header.Add("Authorization", "Bearer "+testAdmin)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatal("duplicate token header accepted")
	}
	for _, body := range []string{`{"name":"one","secret":"injected"}`, `{"name":"one"} {"name":"two"}`, `{"name":"` + strings.Repeat("a", 17*1024) + `"}`} {
		if got := httpRequest(t, handler, "POST", "/api/v1/hosts", body, true); got.Code != 400 {
			t.Fatal(got.Code)
		}
	}
	enrolled := httpRequest(t, handler, "POST", "/api/v1/hosts", `{"name":"测试主机"}`, true)
	if enrolled.Code != 201 {
		t.Fatal(enrolled.Body.String())
	}
	var data map[string]string
	_ = json.Unmarshal(enrolled.Body.Bytes(), &data)
	listed := httpRequest(t, handler, "GET", "/api/v1/hosts", "", true)
	if strings.Contains(listed.Body.String(), data["secret"]) || strings.Contains(listed.Body.String(), "hash") {
		t.Fatal("agent credential leaked")
	}
	if rec := httpRequest(t, handler, "GET", "/api/v1/hosts/"+data["id"]+"/history?range=30d", "", true); rec.Code != 400 {
		t.Fatal(rec.Code)
	}
	if rec := httpRequest(t, handler, "DELETE", "/api/v1/hosts/"+data["id"], "", true); rec.Code != 204 {
		t.Fatal(rec.Code)
	}
	if store.Authenticate(data["id"], data["secret"]) {
		t.Fatal("revoked credential remains active")
	}
}

func TestUpgradeIsRejectedWithoutReadingSlowOrLargeBody(t *testing.T) {
	_, server := newTestServer(t)
	_, endpoint, _ := dialProbe(t, server, false)
	conn, err := net.Dial("tcp", strings.TrimPrefix(endpoint, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, err = fmt.Fprintf(conn, "POST /api/v1/hosts HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: \r\nContent-Length: 1073741824\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(line, "426") {
		t.Fatalf("upgrade waited for body or succeeded: %q %v", line, err)
	}
}

func dialProbe(t *testing.T, server *Server, tlsEnabled bool) (pb.ProbeServiceClient, string, *httptest.Server) {
	t.Helper()
	httpServer := httptest.NewUnstartedServer(server.Handler(!tlsEnabled))
	httpServer.Config.Protocols = serverProtocols(!tlsEnabled)
	var transport credentials.TransportCredentials
	if tlsEnabled {
		httpServer.EnableHTTP2 = true
		httpServer.StartTLS()
		roots := x509.NewCertPool()
		roots.AddCert(httpServer.Certificate())
		transport = credentials.NewTLS(&tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12})
	} else {
		httpServer.Start()
		transport = insecure.NewCredentials()
	}
	t.Cleanup(httpServer.Close)
	conn, err := grpc.NewClient(strings.TrimPrefix(strings.TrimPrefix(httpServer.URL, "https://"), "http://"), grpc.WithTransportCredentials(transport))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return pb.NewProbeServiceClient(conn), httpServer.URL, httpServer
}
func agentContext(id, secret string) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	return metadata.NewOutgoingContext(ctx, metadata.Pairs("client-uuid", id, "client-secret", secret)), cancel
}

func TestRealStreamTLSAndH2CRevoke(t *testing.T) {
	for _, secure := range []bool{false, true} {
		name := "h2c"
		if secure {
			name = "tls"
		}
		t.Run(name, func(t *testing.T) {
			store, server := newTestServer(t)
			id, secret, err := store.Enroll("host")
			if err != nil {
				t.Fatal(err)
			}
			client, _, _ := dialProbe(t, server, secure)
			ctx, cancel := agentContext(id, secret)
			defer cancel()
			if _, err = client.ReportSystemInfo(ctx, &pb.SystemInfo{Hostname: "machine", Os: "linux", Arch: "amd64"}); err != nil {
				t.Fatal(err)
			}
			stream, err := client.ReportSystemState(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = stream.Send(&pb.SystemState{Cpu: ptr(23), NetworkRx: ptr(456)}); err != nil {
				t.Fatal(err)
			}
			ack, err := stream.Recv()
			if err != nil {
				t.Fatal(err)
			}
			at, err := time.Parse(time.RFC3339Nano, ack.ReceivedAt)
			if err != nil || time.Since(at) > time.Second {
				t.Fatal("invalid server time")
			}
			hosts, err := store.Hosts(time.Now())
			if err != nil || len(hosts) != 1 || hosts[0].Status != "online" || hosts[0].Hostname != "machine" || hosts[0].Latest.CPU == nil || *hosts[0].Latest.CPU != 23 {
				t.Fatalf("unexpected host: %+v %v", hosts, err)
			}
			if hosts[0].Latest.Memory != nil {
				t.Fatal("unavailable metric was invented")
			}
			history, err := store.History(id, time.Now().Add(-time.Hour))
			if err != nil || len(history) != 1 {
				t.Fatal(len(history), err)
			}
			if err = server.revoke(id); err != nil {
				t.Fatal(err)
			}
			_, err = stream.Recv()
			if status.Code(err) != codes.Unauthenticated {
				t.Fatalf("active stream not terminated: %v", err)
			}
			if _, err = client.ReportSystemInfo(ctx, &pb.SystemInfo{}); status.Code(err) != codes.Unauthenticated {
				t.Fatal(err)
			}
		})
	}
}

func TestGRPCRejectsDuplicateWrongAndInvalidSamples(t *testing.T) {
	store, server := newTestServer(t)
	id, secret, _ := store.Enroll("host")
	client, _, _ := dialProbe(t, server, false)
	for _, values := range [][]string{{"client-uuid", id, "client-secret", "wrong"}, {"client-uuid", id, "client-secret", secret, "client-secret", secret}, {"client-uuid", id, "client-uuid", id, "client-secret", secret}} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs(values...))
		_, err := client.ReportSystemInfo(ctx, &pb.SystemInfo{})
		cancel()
		if status.Code(err) != codes.Unauthenticated {
			t.Fatalf("invalid credentials accepted: %v", err)
		}
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), -1, 101} {
		ctx, cancel := agentContext(id, secret)
		stream, err := client.ReportSystemState(ctx)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		_ = stream.Send(&pb.SystemState{Cpu: ptr(value)})
		_, err = stream.Recv()
		cancel()
		if status.Code(err) != codes.InvalidArgument {
			t.Fatal(err)
		}
	}
	ctx, cancel := agentContext(id, secret)
	defer cancel()
	stream, err := client.ReportSystemState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.Send(&pb.SystemState{Cpu: ptr(1)})
	if _, err = stream.Recv(); err != nil {
		t.Fatal(err)
	}
	_ = stream.Send(&pb.SystemState{Cpu: ptr(2)})
	_, err = stream.Recv()
	if status.Code(err) != codes.ResourceExhausted {
		t.Fatal("unbounded reporting accepted", err)
	}
}

func TestStoreRecoveryRetentionAndOffline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "probe.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	id, secret, _ := store.Enroll("persistent")
	now := time.Now()
	for _, at := range []time.Time{now.Add(-8 * 24 * time.Hour), now.Add(-8*24*time.Hour + time.Minute), now.Add(-8*24*time.Hour + 2*time.Minute), now.Add(-time.Minute)} {
		sample := Sample{At: utc(at), CPU: ptr(15)}
		if err = store.SaveSample(id, sample, at); err != nil {
			t.Fatal(err)
		}
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if !store.Authenticate(id, secret) {
		t.Fatal("credentials lost on restart")
	}
	hosts, err := store.Hosts(now)
	if err != nil || hosts[0].Status != "offline" || hosts[0].Latest == nil {
		t.Fatal(hosts, err)
	}
	if err = store.Prune(now); err != nil {
		t.Fatal(err)
	}
	history, err := store.History(id, now.Add(-9*24*time.Hour))
	if err != nil || len(history) != 1 {
		t.Fatal(len(history), err)
	}
	for i := 0; i < 725; i++ {
		at := now.Add(time.Duration(i-725) * 30 * time.Second)
		if err = store.SaveSample(id, Sample{At: utc(at), CPU: ptr(float64(i % 100))}, at); err != nil {
			t.Fatal(err)
		}
	}
	history, err = store.History(id, now.Add(-24*time.Hour))
	if err != nil || len(history) != 720 {
		t.Fatal("history not bounded", len(history), err)
	}
	for i := 1; i < len(history); i++ {
		left, _ := time.Parse(time.RFC3339Nano, history[i-1].At)
		right, _ := time.Parse(time.RFC3339Nano, history[i].At)
		if !right.After(left) {
			t.Fatal("history not ordered")
		}
	}
}

func TestHistoryCapacityPrunesAdjacentRecords(t *testing.T) {
	store, _ := newTestServer(t)
	id, _, _ := store.Enroll("capacity")
	now := time.Now()
	err := store.db.Update(func(tx *bolt.Tx) error {
		b, err := tx.Bucket([]byte("samples")).CreateBucketIfNotExists([]byte(id))
		if err != nil {
			return err
		}
		for i := 0; i < maxHistory+7; i++ {
			at := now.Add(-time.Hour + time.Duration(i)*time.Millisecond)
			raw, _ := json.Marshal(Sample{At: utc(at)})
			if err := b.Put(timeKey(at), raw); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Prune(now); err != nil {
		t.Fatal(err)
	}
	err = store.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("samples")).Bucket([]byte(id))
		if count := b.Stats().KeyN; count != maxHistory {
			t.Errorf("remaining records: %d, want %d", count, maxHistory)
		}
		_, raw := b.Cursor().First()
		var first Sample
		if err := json.Unmarshal(raw, &first); err != nil {
			return err
		}
		if first.At != utc(now.Add(-time.Hour+7*time.Millisecond)) {
			t.Error("oldest adjacent records were not all pruned")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentEnrollmentReportingAndRevocation(t *testing.T) {
	store, server := newTestServer(t)
	client, _, _ := dialProbe(t, server, false)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, secret, err := store.Enroll("parallel")
			if err != nil {
				t.Error(err)
				return
			}
			ctx, cancel := agentContext(id, secret)
			defer cancel()
			stream, err := client.ReportSystemState(ctx)
			if err != nil {
				t.Error(err)
				return
			}
			_ = stream.Send(&pb.SystemState{Memory: ptr(22)})
			if _, err = stream.Recv(); err != nil {
				t.Error(err)
				return
			}
			if err = server.revoke(id); err != nil {
				t.Error(err)
			}
			_, err = stream.Recv()
			if status.Code(err) != codes.Unauthenticated {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	hosts, err := store.Hosts(time.Now())
	if err != nil || len(hosts) != 0 {
		t.Fatal(hosts, err)
	}
}

func TestChecksSuccessFailureTimeoutRedirectAndTargets(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); w.WriteHeader(200) }))
	defer target.Close()
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			_, _ = w.Write([]byte("ok"))
		case "/failed":
			w.WriteHeader(503)
		case "/redirect":
			http.Redirect(w, r, target.URL, 302)
		case "/slow":
			<-r.Context().Done()
		case "/large":
			_, _ = w.Write(bytes.Repeat([]byte("x"), 128*1024))
		}
	}))
	defer endpoint.Close()
	for _, tc := range []struct{ path, status string }{{"/ok", "up"}, {"/failed", "down"}, {"/redirect", "down"}, {"/slow", "down"}, {"/large", "up"}} {
		check := Check{CheckInput: CheckInput{Name: "test", Type: "http", Target: endpoint.URL + tc.path, IntervalSeconds: 10, TimeoutMs: 150}}
		result := RunCheck(context.Background(), check)
		if result.Status != tc.status {
			t.Fatal(tc.path, result)
		}
	}
	if redirected.Load() != 0 {
		t.Fatal("redirect followed")
	}
	for _, target := range []string{"http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://100.100.100.200/", "http://[fd00:ec2::254]/", "http://metadata.google.internal/", "http://0.0.0.0/", "http://224.0.0.1/", "http://user:password@example.com/", "file:///etc/passwd", "http://[::ffff:169.254.169.254]/"} {
		if err := validateCheck(CheckInput{Name: "bad", Type: "http", Target: target, IntervalSeconds: 10, TimeoutMs: 100}); err == nil {
			t.Fatal("dangerous target accepted", target)
		}
	}
	check := Check{CheckInput: CheckInput{Name: "tcp", Type: "tcp", Target: strings.TrimPrefix(endpoint.URL, "http://"), IntervalSeconds: 10, TimeoutMs: 1000}}
	if result := RunCheck(context.Background(), check); result.Status != "up" {
		t.Fatal(result)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	check.Target = listener.Addr().String()
	_ = listener.Close()
	if result := RunCheck(context.Background(), check); result.Status != "down" {
		t.Fatal(result)
	}
}

func TestCheckRevisionCannotRestoreOldOrDeletedData(t *testing.T) {
	store, _ := newTestServer(t)
	input := CheckInput{Name: "web", Type: "http", Target: "https://example.com", IntervalSeconds: 10, TimeoutMs: 100}
	check, err := store.SaveCheck(input)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err = store.SaveResult(check, CheckResult{At: utc(now), Status: "up", Message: "HTTP 200"}, now); err != nil {
		t.Fatal(err)
	}
	checks, err := store.Checks(now)
	if err != nil || len(checks) != 1 || checks[0].Uptime24h == nil || *checks[0].Uptime24h != 100 {
		t.Fatal(checks, err)
	}
	input.ID = check.ID
	input.Name = "renamed"
	input.TimeoutMs = 200
	renamed, err := store.SaveCheck(input)
	if err != nil || renamed.Status != "up" {
		t.Fatal(renamed, err)
	}
	kept, err := store.CheckHistory(check.ID, now.Add(-time.Hour))
	if err != nil || len(kept) != 1 {
		t.Fatal("renaming or changing timeout erased history", kept, err)
	}
	input.ID = check.ID
	input.Target = "https://example.org"
	updated, err := store.SaveCheck(input)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.SaveResult(check, CheckResult{At: utc(now), Status: "down"}, now); err == nil {
		t.Fatal("old result overwrote changed configuration")
	}
	results, err := store.CheckHistory(check.ID, now.Add(-time.Hour))
	if err != nil || len(results) != 0 {
		t.Fatal("old history persisted", results, err)
	}
	if err = store.DeleteCheck(updated.ID); err != nil {
		t.Fatal(err)
	}
	if err = store.SaveResult(updated, CheckResult{At: utc(now), Status: "up"}, now); err == nil {
		t.Fatal("deleted check was restored")
	}
}

func TestSchedulerFairnessAndConfigurationRefresh(t *testing.T) {
	t.Run("waiting check gets a slot before repeating slow checks", func(t *testing.T) {
		store, server := newTestServer(t)
		for i := 0; i < 9; i++ {
			_, err := store.SaveCheck(CheckInput{ID: fmt.Sprintf("a%02d", i), Name: "queued", Type: "tcp", Target: "127.0.0.1:9", IntervalSeconds: 10, TimeoutMs: 10000})
			if err != nil {
				t.Fatal(err)
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		ticks := make(chan time.Time)
		started := make(chan string, 64)
		done := make(chan struct{})
		firstGate := make(chan struct{})
		var mu sync.Mutex
		counts := map[string]int{}
		go func() {
			server.runChecks(ctx, ticks, func(ctx context.Context, c Check) CheckResult {
				mu.Lock()
				counts[c.ID]++
				count := counts[c.ID]
				mu.Unlock()
				started <- c.ID
				if c.ID != "a08" && count == 1 {
					select {
					case <-firstGate:
					case <-ctx.Done():
					}
				} else {
					<-ctx.Done()
				}
				return CheckResult{At: utc(time.Now()), Status: "up"}
			})
			close(done)
		}()
		defer func() { cancel(); <-done }()
		now := time.Now()
		ticks <- now
		for i := 0; i < 8; i++ {
			select {
			case id := <-started:
				if id == "a08" {
					t.Fatal("queue setup invalid")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("initial workers did not start")
			}
		}
		close(firstGate)
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		deadline := time.After(2 * time.Second)
		for {
			select {
			case id := <-started:
				if id == "a08" {
					return
				}
			case <-ticker.C:
				ticks <- now.Add(10 * time.Second)
			case <-deadline:
				t.Fatal("ninth check starved behind recurring slow checks")
			}
		}
	})
	t.Run("changed configuration does not wait for the old hourly interval", func(t *testing.T) {
		store, server := newTestServer(t)
		old, err := store.SaveCheck(CheckInput{Name: "hourly", Type: "tcp", Target: "127.0.0.1:9", IntervalSeconds: 3600, TimeoutMs: 100})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		ticks := make(chan time.Time)
		started := make(chan Check, 4)
		done := make(chan struct{})
		go func() {
			server.runChecks(ctx, ticks, func(_ context.Context, c Check) CheckResult {
				started <- c
				return CheckResult{At: utc(time.Now()), Status: "up"}
			})
			close(done)
		}()
		defer func() { cancel(); <-done }()
		now := time.Now()
		ticks <- now
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("initial check did not run")
		}
		input := old.CheckInput
		input.IntervalSeconds = 10
		input.Target = "127.0.0.1:10"
		updated, err := store.SaveCheck(input)
		if err != nil {
			t.Fatal(err)
		}
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		deadline := time.After(time.Second)
		for {
			select {
			case check := <-started:
				if check.Revision == updated.Revision && check.Target == input.Target {
					return
				}
			case <-ticker.C:
				ticks <- now.Add(time.Second)
			case <-deadline:
				t.Fatal("new check configuration stuck behind old deadline")
			}
		}
	})
}

func TestAgentTransportValidationAndRealCollection(t *testing.T) {
	cfg := AgentConfig{Endpoint: "http://127.0.0.1:8008", ID: "host", Secret: strings.Repeat("x", 32), IntervalSeconds: 3}
	if _, _, err := cfg.connection(); err == nil {
		t.Fatal("plaintext enabled by default")
	}
	cfg.AllowInsecure = true
	if _, _, err := cfg.connection(); err != nil {
		t.Fatal(err)
	}
	cfg.Endpoint = "http://8.8.8.8:8008"
	if _, _, err := cfg.connection(); err == nil {
		t.Fatal("public plaintext endpoint accepted")
	}
	cfg.Endpoint = "http://probe.example.com:8008"
	if _, _, err := cfg.connection(); err == nil {
		t.Fatal("plaintext DNS name accepted")
	}
	cfg.Endpoint = "https://user:password@example.com"
	if _, _, err := cfg.connection(); err == nil {
		t.Fatal("embedded credentials accepted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sample := (&Sampler{}).Sample(ctx)
	if sample.MemoryTotal == nil || *sample.MemoryTotal <= 0 || sample.Uptime == nil {
		t.Fatal("real system metrics unavailable")
	}
	if sample.Cpu != nil || sample.RxRate != nil || sample.Gpu != nil {
		t.Fatal("first CPU/rate or unavailable GPU fabricated")
	}
	if _, err := sampleFromState(sample, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestRealAgentThroughTLS(t *testing.T) {
	store, server := newTestServer(t)
	id, secret, _ := store.Enroll("live-agent")
	_, endpoint, httpServer := dialProbe(t, server, true)
	caPath := filepath.Join(t.TempDir(), "test-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: httpServer.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- RunAgent(ctx, AgentConfig{Endpoint: endpoint, ID: id, Secret: secret, CAFile: caPath, IntervalSeconds: 1}, func(string) {})
	}()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("agent failed to stop")
		}
	}()
	deadline := time.After(20 * time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("real agent failed to report")
		case <-ticker.C:
			hosts, err := store.Hosts(time.Now())
			if err == nil && len(hosts) == 1 && hosts[0].Latest != nil && hosts[0].Latest.CPU != nil && hosts[0].Latest.RxRate != nil {
				if hosts[0].Hostname == "" || hosts[0].Status != "online" {
					t.Fatal(hosts[0])
				}
				return
			}
		}
	}
}

func TestSchedulerPersistsAutomaticResultsAndStops(t *testing.T) {
	store, server := newTestServer(t)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer endpoint.Close()
	check, err := store.SaveCheck(CheckInput{Name: "automatic", Type: "http", Target: endpoint.URL, IntervalSeconds: 10, TimeoutMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { server.RunChecks(ctx); close(done) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("scheduler did not stop")
		}
	}()
	deadline := time.After(4 * time.Second)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("no automatic check result")
		case <-ticker.C:
			results, err := store.CheckHistory(check.ID, time.Now().Add(-time.Hour))
			if err == nil && len(results) > 0 {
				if results[0].Status != "up" {
					t.Fatal(results[0])
				}
				return
			}
		}
	}
}

func TestAgentReconnectsAfterServerRestart(t *testing.T) {
	store, first := newTestServer(t)
	id, secret, err := store.Enroll("reconnecting")
	if err != nil {
		t.Fatal(err)
	}
	start := func(server *Server, address string) (string, context.CancelFunc, <-chan error) {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- server.Serve(ctx, listener, "", "", true) }()
		return listener.Addr().String(), cancel, done
	}
	address, stopFirst, firstDone := start(first, "127.0.0.1:0")
	defer stopFirst()
	ctx, stopAgent := context.WithCancel(context.Background())
	agentDone := make(chan error, 1)
	go func() {
		agentDone <- RunAgent(ctx, AgentConfig{Endpoint: "http://" + address, ID: id, Secret: secret, IntervalSeconds: 1, AllowInsecure: true}, func(string) {})
	}()
	defer func() {
		stopAgent()
		select {
		case err := <-agentDone:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("agent did not stop")
		}
	}()
	waitSample := func(after time.Time) {
		deadline := time.After(15 * time.Second)
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-deadline:
				t.Fatal("agent did not report after restart")
			case <-ticker.C:
				hosts, err := store.Hosts(time.Now())
				if err == nil && len(hosts) == 1 && hosts[0].LastSeen != nil {
					at, _ := time.Parse(time.RFC3339Nano, *hosts[0].LastSeen)
					if at.After(after) {
						return
					}
				}
			}
		}
	}
	waitSample(time.Time{})
	stopFirst()
	select {
	case err := <-firstDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first server did not stop")
	}
	restartedAt := time.Now()
	second, err := NewServer(store, testAdmin)
	if err != nil {
		t.Fatal(err)
	}
	_, stopSecond, secondDone := start(second, address)
	defer func() {
		stopSecond()
		select {
		case err := <-secondDone:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("restarted server did not stop")
		}
	}()
	waitSample(restartedAt)
}
