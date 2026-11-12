# syntax=docker/dockerfile:1

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/gateway ./cmd/gateway \
    && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/gateway /gateway
# /data will hold the SQLite database and the WhatsApp session (stage 1+).
# Created here so a named volume inherits the non-root owner.
COPY --from=build --chown=nonroot:nonroot /out/data /data
VOLUME /data
USER nonroot
EXPOSE 8080
# The image has no shell or curl; the binary checks its own /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/gateway", "-healthcheck"]
ENTRYPOINT ["/gateway"]
