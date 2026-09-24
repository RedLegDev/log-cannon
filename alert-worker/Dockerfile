FROM golang:1.26-alpine AS builder

WORKDIR /src
COPY go/ship ./go/ship
COPY alert-worker ./alert-worker
WORKDIR /src/alert-worker
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /alert-worker .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /alert-worker .
CMD ["./alert-worker"]
