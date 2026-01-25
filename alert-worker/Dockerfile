FROM golang:1.21-alpine AS builder

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || go mod tidy

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o alert-worker .

FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/alert-worker .

CMD ["./alert-worker"]
