package probe

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	pb "github.com/Songwo/zhiyu/services/probe/proto"
	"golang.org/x/net/netutil"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type Server struct {
	pb.UnimplementedProbeServiceServer
	store   *Store
	admin   string
	grpc    *grpc.Server
	mu      sync.Mutex
	streams map[string]chan struct{}
}

func NewServer(store *Store, admin string) (*Server, error) {
	if len(admin) < 32 || len(admin) > 256 || strings.TrimSpace(admin) != admin || strings.ContainsAny(admin, "\r\n\t ") {
		return nil, errors.New("admin token must contain 32–256 non-whitespace characters")
	}
	unique := map[rune]bool{}
	for _, r := range admin {
		unique[r] = true
	}
	if len(unique) < 8 {
		return nil, errors.New("admin token is too weak; generate a random token")
	}
	s := &Server{store: store, admin: admin, streams: map[string]chan struct{}{}}
	s.grpc = grpc.NewServer(grpc.MaxRecvMsgSize(16*1024), grpc.MaxSendMsgSize(16*1024), grpc.MaxConcurrentStreams(128))
	pb.RegisterProbeServiceServer(s.grpc, s)
	return s, nil
}
func (s *Server) Stop() { s.grpc.Stop() }
func (s *Server) credentials(ctx context.Context) (string, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return "", status.Error(codes.Unauthenticated, "invalid agent credentials")
	}
	ids, secrets := md.Get("client-uuid"), md.Get("client-secret")
	if len(ids) != 1 || len(secrets) != 1 || !s.store.Authenticate(ids[0], secrets[0]) {
		return "", status.Error(codes.Unauthenticated, "invalid agent credentials")
	}
	return ids[0], nil
}
func (s *Server) ReportSystemInfo(ctx context.Context, info *pb.SystemInfo) (*pb.Ack, error) {
	id, err := s.credentials(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.store.UpdateInfo(id, info.Hostname, info.Os, info.Arch); err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid host information")
	}
	return &pb.Ack{ReceivedAt: utc(time.Now())}, nil
}
func (s *Server) ReportSystemState(stream grpc.BidiStreamingServer[pb.SystemState, pb.Ack]) error {
	// 与撤销共用同一把锁，保证认证到注册之间不会遗漏撤销。
	s.mu.Lock()
	id, err := s.credentials(stream.Context())
	if err != nil {
		s.mu.Unlock()
		return err
	}
	closed := make(chan struct{})
	if old := s.streams[id]; old != nil {
		close(old)
	}
	s.streams[id] = closed
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.streams[id] == closed {
			delete(s.streams, id)
		}
		s.mu.Unlock()
	}()
	type incoming struct {
		state *pb.SystemState
		err   error
	}
	received := make(chan incoming, 1)
	go func() {
		for {
			state, err := stream.Recv()
			select {
			case received <- incoming{state, err}:
			case <-stream.Context().Done():
				return
			case <-closed:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	var previous time.Time
	for {
		select {
		case <-closed:
			return status.Error(codes.Unauthenticated, "agent revoked or connection replaced")
		case <-stream.Context().Done():
			return stream.Context().Err()
		case v := <-received:
			if v.err == io.EOF {
				return nil
			}
			if v.err != nil {
				return v.err
			}
			now := time.Now()
			if !previous.IsZero() && now.Sub(previous) < 500*time.Millisecond {
				return status.Error(codes.ResourceExhausted, "report interval must be at least one second")
			}
			previous = now
			sample, err := sampleFromState(v.state, now)
			if err != nil {
				return status.Error(codes.InvalidArgument, "invalid sample")
			}
			if err = s.store.SaveSample(id, sample, now); err != nil {
				return status.Error(codes.Unauthenticated, "agent unavailable")
			}
			if err = stream.Send(&pb.Ack{ReceivedAt: sample.At}); err != nil {
				return err
			}
		}
	}
}
func (s *Server) revoke(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.Revoke(id); err != nil {
		return err
	}
	if c := s.streams[id]; c != nil {
		close(c)
		delete(s.streams, id)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	if value != nil {
		_ = json.NewEncoder(w).Encode(value)
	}
}
func fail(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	// 仅限制短 API 请求的读入，避免把长期 gRPC 状态流也一起超时。
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Second))
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		fail(w, 415, "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "invalid request body")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		fail(w, 400, "request must contain one JSON value")
		return false
	}
	return true
}
func historySince(r *http.Request) (time.Time, error) {
	switch r.URL.Query().Get("range") {
	case "", "1h":
		return time.Now().Add(-time.Hour), nil
	case "24h":
		return time.Now().Add(-24 * time.Hour), nil
	case "7d":
		return time.Now().Add(-retention), nil
	default:
		return time.Time{}, errors.New("invalid range")
	}
}
func (s *Server) api() http.Handler {
	mux := http.NewServeMux()
	apiSlots := make(chan struct{}, 32)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	api := http.NewServeMux()
	api.HandleFunc("GET /api/v1/hosts", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Hosts(time.Now())
		if err != nil {
			fail(w, 500, "storage unavailable")
			return
		}
		writeJSON(w, 200, v)
	})
	api.HandleFunc("POST /api/v1/hosts", func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			Name string `json:"name"`
		}
		if !decode(w, r, &v) {
			return
		}
		id, secret, err := s.store.Enroll(v.Name)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		writeJSON(w, 201, map[string]string{"id": id, "secret": secret})
	})
	api.HandleFunc("DELETE /api/v1/hosts/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := s.revoke(r.PathValue("id")); err != nil {
			if errors.Is(err, errNotFound) {
				fail(w, 404, "host not found")
			} else {
				fail(w, 500, "storage unavailable")
			}
			return
		}
		w.WriteHeader(204)
	})
	api.HandleFunc("GET /api/v1/hosts/{id}/history", func(w http.ResponseWriter, r *http.Request) {
		since, err := historySince(r)
		if err != nil {
			fail(w, 400, "invalid range")
			return
		}
		v, err := s.store.History(r.PathValue("id"), since)
		if err != nil {
			fail(w, 500, "storage unavailable")
			return
		}
		writeJSON(w, 200, v)
	})
	api.HandleFunc("GET /api/v1/checks", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.store.Checks(time.Now())
		if err != nil {
			fail(w, 500, "storage unavailable")
			return
		}
		writeJSON(w, 200, v)
	})
	api.HandleFunc("POST /api/v1/checks", func(w http.ResponseWriter, r *http.Request) {
		var v CheckInput
		if !decode(w, r, &v) {
			return
		}
		check, err := s.store.SaveCheck(v)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		writeJSON(w, 200, check)
	})
	api.HandleFunc("DELETE /api/v1/checks/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := s.store.DeleteCheck(r.PathValue("id")); err != nil {
			if errors.Is(err, errNotFound) {
				fail(w, 404, "check not found")
			} else {
				fail(w, 500, "storage unavailable")
			}
			return
		}
		w.WriteHeader(204)
	})
	api.HandleFunc("GET /api/v1/checks/{id}/history", func(w http.ResponseWriter, r *http.Request) {
		since, err := historySince(r)
		if err != nil {
			fail(w, 400, "invalid range")
			return
		}
		v, err := s.store.CheckHistory(r.PathValue("id"), since)
		if err != nil {
			fail(w, 500, "storage unavailable")
			return
		}
		writeJSON(w, 200, v)
	})
	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokens := r.Header.Values("Authorization")
		expected := "Bearer " + s.admin
		if len(tokens) != 1 || subtle.ConstantTimeCompare([]byte(tokens[0]), []byte(expected)) != 1 {
			fail(w, 401, "invalid administrator credentials")
			return
		}
		select {
		case apiSlots <- struct{}{}:
			defer func() { <-apiSlots }()
		default:
			fail(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		api.ServeHTTP(w, r)
	}))
	return mux
}

func (s *Server) Handler(insecure bool) http.Handler {
	api := s.api()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// 原生 HTTP/2 使用 prior knowledge；拒绝旧式 HTTP/1 Upgrade，
		// 避免升级前缓存请求体及慢速首包占用连接。
		if strings.EqualFold(r.Header.Get("Upgrade"), "h2c") {
			r.Close = true
			w.Header().Set("Connection", "close")
			fail(w, http.StatusUpgradeRequired, "use HTTP/2 prior knowledge")
			return
		}
		if r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc") && strings.HasPrefix(r.URL.Path, "/zhiyu.probe.v1.ProbeService/") {
			s.grpc.ServeHTTP(w, r)
			return
		}
		api.ServeHTTP(w, r)
	})
	return handler
}

func serverProtocols(insecure bool) *http.Protocols {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetHTTP2(!insecure)
	protocols.SetUnencryptedHTTP2(insecure)
	return protocols
}

func (s *Server) Serve(ctx context.Context, listener net.Listener, cert, key string, insecure bool) error {
	if !insecure && (cert == "" || key == "") {
		return errors.New("TLS certificate and key are required unless --insecure is explicitly set")
	}
	listener = netutil.LimitListener(listener, 256)
	srv := &http.Server{Handler: s.Handler(insecure), Protocols: serverProtocols(insecure), HTTP2: &http.HTTP2Config{MaxConcurrentStreams: 128, SendPingTimeout: 60 * time.Second, PingTimeout: 10 * time.Second}, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 * 1024, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	ctx, cancel := context.WithCancel(ctx)
	checksDone := make(chan struct{})
	go func() { defer close(checksDone); s.RunChecks(ctx) }()
	defer func() { cancel(); <-checksDone }()
	go func() {
		<-ctx.Done()
		s.grpc.Stop()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	var err error
	if insecure {
		err = srv.Serve(listener)
	} else {
		err = srv.ServeTLS(listener, cert, key)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
