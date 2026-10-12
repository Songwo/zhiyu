FROM golang:1.27.2-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /zhiyu-probe ./cmd/zhiyu-probe \
    && mkdir /probe-data && chown 10001:10001 /probe-data && chmod 700 /probe-data

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /zhiyu-probe /zhiyu-probe
COPY --from=build --chown=10001:10001 /probe-data /data
USER 10001:10001
EXPOSE 8008
ENTRYPOINT ["/zhiyu-probe"]
CMD ["server", "--listen", "0.0.0.0:8008", "--data", "/data/probe.db", "--admin-token-file", "/run/zhiyu/admin-token", "--tls-cert", "/run/zhiyu/tls.crt", "--tls-key", "/run/zhiyu/tls.key"]
