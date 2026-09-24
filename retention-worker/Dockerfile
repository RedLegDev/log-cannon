FROM golang:1.26-alpine AS builder

WORKDIR /src
COPY go/ship ./go/ship
COPY retention-worker ./retention-worker
WORKDIR /src/retention-worker
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /retention-worker .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /retention-worker .
CMD ["./retention-worker"]
