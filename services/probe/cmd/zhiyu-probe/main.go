package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Songwo/zhiyu/services/probe/internal/probe"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: zhiyu-probe server | agent | token")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch os.Args[1] {
	case "token":
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		fmt.Println(base64.RawURLEncoding.EncodeToString(b))
		return nil
	case "agent":
		flags := flag.NewFlagSet("agent", flag.ContinueOnError)
		config := flags.String("config", "", "private agent JSON configuration path")
		if err := flags.Parse(os.Args[2:]); err != nil {
			return err
		}
		cfg, err := probe.LoadAgentConfig(*config)
		if err != nil {
			return err
		}
		return probe.RunAgent(ctx, cfg, func(state string) { log.Printf("agent: %s", state) })
	case "server":
		flags := flag.NewFlagSet("server", flag.ContinueOnError)
		listen := flags.String("listen", "127.0.0.1:8008", "HTTP/gRPC shared listen address")
		database := flags.String("data", "./data/probe.db", "database path")
		tokenFile := flags.String("admin-token-file", "", "private admin token file")
		cert := flags.String("tls-cert", "", "TLS certificate PEM")
		key := flags.String("tls-key", "", "TLS key PEM")
		insecure := flags.Bool("insecure", false, "explicitly allow plaintext h2c (private networks only)")
		if err := flags.Parse(os.Args[2:]); err != nil {
			return err
		}
		if !*insecure && (*cert == "" || *key == "") {
			return errors.New("TLS is required; provide --tls-cert and --tls-key")
		}
		raw, err := probe.ReadPrivateFile(*tokenFile)
		if err != nil {
			return err
		}
		store, err := probe.OpenStore(*database)
		if err != nil {
			return err
		}
		defer store.Close()
		server, err := probe.NewServer(store, strings.TrimSpace(string(raw)))
		if err != nil {
			return err
		}
		defer server.Stop()
		listener, err := net.Listen("tcp", *listen)
		if err != nil {
			return err
		}
		defer listener.Close()
		log.Printf("probe server listening on %s (TLS: %t)", listener.Addr(), !*insecure)
		return server.Serve(ctx, listener, *cert, *key, *insecure)
	default:
		return errors.New("unknown command; use server, agent or token")
	}
}
