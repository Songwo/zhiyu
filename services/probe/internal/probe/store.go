package probe

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	bolt "go.etcd.io/bbolt"
)

var errNotFound = errors.New("not found")

const retention = 7 * 24 * time.Hour
const maxHistory = 20160
const maxPoints = 720

type Store struct{ db *bolt.DB }
type storedHost struct {
	Host Host   `json:"host"`
	Hash []byte `json:"hash"`
}
type storedCheck struct {
	Check    Check  `json:"check"`
	Revision string `json:"revision"`
}

func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if st, err := os.Lstat(path); err == nil {
		if !st.Mode().IsRegular() {
			return nil, errors.New("data file must be a regular file")
		}
		if runtime.GOOS != "windows" && st.Mode().Perm()&0077 != 0 {
			return nil, errors.New("data file permissions must be 0600")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, n := range []string{"hosts", "checks", "samples", "results"} {
			if _, e := tx.CreateBucketIfNotExists([]byte(n)); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func putJSON(b *bolt.Bucket, k string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return b.Put([]byte(k), raw)
}
func readJSON(b *bolt.Bucket, k string, v any) error {
	raw := b.Get([]byte(k))
	if raw == nil {
		return errNotFound
	}
	return json.Unmarshal(raw, v)
}
func (s *Store) Enroll(name string) (string, string, error) {
	name = strings.TrimSpace(name)
	if len(name) == 0 || utf8.RuneCountInString(name) > 160 {
		return "", "", errors.New("name must contain 1–160 characters")
	}
	id, secret := randomToken(18), randomToken(32)
	hash := sha256.Sum256([]byte(secret))
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("hosts"))
		if b.Stats().KeyN >= 100 {
			return errors.New("host limit reached")
		}
		return putJSON(b, id, storedHost{Host: Host{ID: id, Name: name, Status: "pending"}, Hash: hash[:]})
	})
	return id, secret, err
}
func (s *Store) Authenticate(id, secret string) bool {
	if len(id) > 100 || len(secret) > 256 {
		return false
	}
	hash := sha256.Sum256([]byte(secret))
	ok := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		var v storedHost
		if readJSON(tx.Bucket([]byte("hosts")), id, &v) == nil {
			ok = subtle.ConstantTimeCompare(v.Hash, hash[:]) == 1
		}
		return nil
	})
	return ok
}
func (s *Store) Revoke(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("hosts"))
		if b.Get([]byte(id)) == nil {
			return errNotFound
		}
		if err := b.Delete([]byte(id)); err != nil {
			return err
		}
		if tx.Bucket([]byte("samples")).Bucket([]byte(id)) != nil {
			return tx.Bucket([]byte("samples")).DeleteBucket([]byte(id))
		}
		return nil
	})
}
func (s *Store) UpdateInfo(id, hostname, osName, arch string) error {
	if len(hostname) > 255 || len(osName) > 128 || len(arch) > 64 {
		return errors.New("system information too long")
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("hosts"))
		var v storedHost
		if err := readJSON(b, id, &v); err != nil {
			return err
		}
		v.Host.Hostname = hostname
		v.Host.OS = osName
		v.Host.Arch = arch
		return putJSON(b, id, v)
	})
}
func timeKey(t time.Time) []byte {
	v := make([]byte, 8)
	binary.BigEndian.PutUint64(v, uint64(t.UnixMilli()))
	return v
}
func appendHistory(tx *bolt.Tx, bucket, id string, at time.Time, value any) error {
	b, err := tx.Bucket([]byte(bucket)).CreateBucketIfNotExists([]byte(id))
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	// 同一 30 秒桶保留最新样本，控制历史写入规模。
	return b.Put(timeKey(at.Truncate(30*time.Second)), raw)
}
func (s *Store) SaveSample(id string, sample Sample, at time.Time) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("hosts"))
		var v storedHost
		if err := readJSON(b, id, &v); err != nil {
			return err
		}
		v.Host.Latest = &sample
		v.Host.LastSeen = &sample.At
		v.Host.Status = "online"
		if err := putJSON(b, id, v); err != nil {
			return err
		}
		return appendHistory(tx, "samples", id, at, sample)
	})
}
func (s *Store) Hosts(now time.Time) ([]Host, error) {
	out := []Host{}
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("hosts")).ForEach(func(k, v []byte) error {
			var row storedHost
			if err := json.Unmarshal(v, &row); err != nil {
				return err
			}
			h := row.Host
			h.Status = "pending"
			if h.LastSeen != nil {
				h.Status = "offline"
				at, err := time.Parse(time.RFC3339Nano, *h.LastSeen)
				if err == nil && now.Sub(at) < 15*time.Second && now.Sub(at) >= 0 {
					h.Status = "online"
				}
			}
			out = append(out, h)
			return nil
		})
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, err
}

func readHistory[T any](s *Store, bucket, id string, since time.Time) ([]T, error) {
	out := []T{}
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(bucket)).Bucket([]byte(id))
		if b == nil {
			return nil
		}
		c := b.Cursor()
		for k, v := c.Seek(timeKey(since.Truncate(30 * time.Second))); k != nil; k, v = c.Next() {
			var item T
			if err := json.Unmarshal(v, &item); err != nil {
				return err
			}
			out = append(out, item)
		}
		return nil
	})
	return out, err
}
func thin[T any](in []T) []T {
	if len(in) <= maxPoints {
		return in
	}
	out := make([]T, 0, maxPoints)
	for i := 0; i < maxPoints; i++ {
		out = append(out, in[i*(len(in)-1)/(maxPoints-1)])
	}
	return out
}
func (s *Store) History(id string, since time.Time) ([]Sample, error) {
	v, e := readHistory[Sample](s, "samples", id, since)
	return thin(v), e
}
func (s *Store) CheckHistory(id string, since time.Time) ([]CheckResult, error) {
	v, e := readHistory[CheckResult](s, "results", id, since)
	return thin(v), e
}
func (s *Store) SaveCheck(input CheckInput) (Check, error) {
	if err := validateCheck(input); err != nil {
		return Check{}, err
	}
	if input.ID == "" {
		input.ID = randomToken(18)
	}
	c := Check{CheckInput: input, Status: "pending", Revision: randomToken(16)}
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("checks"))
		if b.Get([]byte(input.ID)) == nil && b.Stats().KeyN >= 100 {
			return errors.New("check limit reached")
		}
		var old storedCheck
		if err := readJSON(b, input.ID, &old); err != nil && !errors.Is(err, errNotFound) {
			return err
		}
		sameTarget := old.Check.ID != "" && old.Check.Type == input.Type && old.Check.Target == input.Target
		if sameTarget {
			c.Status = old.Check.Status
			c.LastCheckedAt = old.Check.LastCheckedAt
			c.LatencyMs = old.Check.LatencyMs
			c.Message = old.Check.Message
		}
		// 修改目标后清空旧结果，不能混淆两个服务的可用率。
		if !sameTarget && tx.Bucket([]byte("results")).Bucket([]byte(input.ID)) != nil {
			if err := tx.Bucket([]byte("results")).DeleteBucket([]byte(input.ID)); err != nil {
				return err
			}
		}
		return putJSON(b, input.ID, storedCheck{Check: c, Revision: c.Revision})
	})
	return c, err
}
func (s *Store) DeleteCheck(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("checks"))
		if b.Get([]byte(id)) == nil {
			return errNotFound
		}
		if err := b.Delete([]byte(id)); err != nil {
			return err
		}
		if tx.Bucket([]byte("results")).Bucket([]byte(id)) != nil {
			return tx.Bucket([]byte("results")).DeleteBucket([]byte(id))
		}
		return nil
	})
}
func (s *Store) configuredChecks() ([]Check, error) {
	out := []Check{}
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("checks")).ForEach(func(k, v []byte) error {
			var row storedCheck
			if err := json.Unmarshal(v, &row); err != nil {
				return err
			}
			row.Check.Revision = row.Revision
			out = append(out, row.Check)
			return nil
		})
	})
	return out, err
}
func (s *Store) Checks(now time.Time) ([]Check, error) {
	out, err := s.configuredChecks()
	if err != nil {
		return nil, err
	}
	for i := range out {
		results, e := readHistory[CheckResult](s, "results", out[i].ID, now.Add(-24*time.Hour))
		if e != nil {
			return nil, e
		}
		up := 0
		for _, r := range results {
			if r.Status == "up" {
				up++
			}
		}
		if len(results) > 0 {
			rate := float64(up) * 100 / float64(len(results))
			out[i].Uptime24h = &rate
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
func (s *Store) SaveResult(check Check, result CheckResult, at time.Time) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("checks"))
		var row storedCheck
		if err := readJSON(b, check.ID, &row); err != nil {
			return err
		}
		if row.Revision != check.Revision {
			return errors.New("check configuration changed")
		}
		row.Check.Status = result.Status
		row.Check.LastCheckedAt = &result.At
		row.Check.LatencyMs = result.LatencyMs
		row.Check.Message = result.Message
		if err := putJSON(b, check.ID, row); err != nil {
			return err
		}
		return appendHistory(tx, "results", check.ID, at, result)
	})
}
func (s *Store) Prune(now time.Time) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"samples", "results"} {
			root := tx.Bucket([]byte(name))
			err := root.ForEach(func(k, v []byte) error {
				if v != nil {
					return fmt.Errorf("invalid history bucket")
				}
				b := root.Bucket(k)
				c := b.Cursor()
				cut := timeKey(now.Add(-retention))
				for key, _ := c.First(); key != nil && strings.Compare(string(key), string(cut)) < 0; key, _ = c.Next() {
					if err := c.Delete(); err != nil {
						return err
					}
				}
				extra := b.Stats().KeyN - maxHistory
				c = b.Cursor()
				for key, _ := c.First(); key != nil && extra > 0; key, _ = c.Next() {
					if err := c.Delete(); err != nil {
						return err
					}
					extra--
				}
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
}
