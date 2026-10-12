package probe

import (
	"errors"
	"math"
	"time"

	pb "github.com/Songwo/zhiyu/services/probe/proto"
)

type Sample struct {
	At          string   `json:"at"`
	CPU         *float64 `json:"cpu,omitempty"`
	Memory      *float64 `json:"memory,omitempty"`
	Swap        *float64 `json:"swap,omitempty"`
	Disk        *float64 `json:"disk,omitempty"`
	MemoryTotal *float64 `json:"memoryTotal,omitempty"`
	DiskTotal   *float64 `json:"diskTotal,omitempty"`
	NetworkRx   *float64 `json:"networkRx,omitempty"`
	NetworkTx   *float64 `json:"networkTx,omitempty"`
	RxRate      *float64 `json:"rxRate,omitempty"`
	TxRate      *float64 `json:"txRate,omitempty"`
	Uptime      *float64 `json:"uptime,omitempty"`
	Load1       *float64 `json:"load1,omitempty"`
	Load5       *float64 `json:"load5,omitempty"`
	Load15      *float64 `json:"load15,omitempty"`
	TCP         *float64 `json:"tcp,omitempty"`
	UDP         *float64 `json:"udp,omitempty"`
	Processes   *float64 `json:"processes,omitempty"`
	Temperature *float64 `json:"temperature,omitempty"`
	GPU         *float64 `json:"gpu,omitempty"`
}

type Host struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Hostname string  `json:"hostname"`
	OS       string  `json:"os"`
	Arch     string  `json:"arch"`
	Status   string  `json:"status"`
	LastSeen *string `json:"lastSeen"`
	Latest   *Sample `json:"latest"`
}

type CheckInput struct {
	ID              string `json:"id,omitempty"`
	Name            string `json:"name"`
	Type            string `json:"type"`
	Target          string `json:"target"`
	IntervalSeconds int    `json:"intervalSeconds"`
	TimeoutMs       int    `json:"timeoutMs"`
}

type Check struct {
	CheckInput
	Status        string   `json:"status"`
	LastCheckedAt *string  `json:"lastCheckedAt"`
	LatencyMs     *float64 `json:"latencyMs"`
	Message       string   `json:"message"`
	Uptime24h     *float64 `json:"uptime24h"`
	Revision      string   `json:"-"`
}

type CheckResult struct {
	At        string   `json:"at"`
	Status    string   `json:"status"`
	LatencyMs *float64 `json:"latencyMs"`
	Message   string   `json:"message"`
}

func utc(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func sampleFromState(s *pb.SystemState, now time.Time) (Sample, error) {
	v := Sample{At: utc(now), CPU: s.Cpu, Memory: s.Memory, Swap: s.Swap, Disk: s.Disk,
		MemoryTotal: s.MemoryTotal, DiskTotal: s.DiskTotal, NetworkRx: s.NetworkRx, NetworkTx: s.NetworkTx,
		RxRate: s.RxRate, TxRate: s.TxRate, Uptime: s.Uptime, Load1: s.Load1, Load5: s.Load5,
		Load15: s.Load15, TCP: s.Tcp, UDP: s.Udp, Processes: s.Processes, Temperature: s.Temperature, GPU: s.Gpu}
	for _, p := range []*float64{v.CPU, v.Memory, v.Swap, v.Disk, v.GPU} {
		if p != nil && (math.IsNaN(*p) || math.IsInf(*p, 0) || *p < 0 || *p > 100) {
			return Sample{}, errors.New("invalid percentage")
		}
	}
	for _, p := range []*float64{v.MemoryTotal, v.DiskTotal, v.NetworkRx, v.NetworkTx, v.RxRate, v.TxRate, v.Uptime, v.Load1, v.Load5, v.Load15, v.TCP, v.UDP, v.Processes} {
		if p != nil && (math.IsNaN(*p) || math.IsInf(*p, 0) || *p < 0 || *p > 9e18) {
			return Sample{}, errors.New("invalid metric")
		}
	}
	if v.Temperature != nil && (math.IsNaN(*v.Temperature) || math.IsInf(*v.Temperature, 0) || *v.Temperature < -100 || *v.Temperature > 250) {
		return Sample{}, errors.New("invalid temperature")
	}
	return v, nil
}
