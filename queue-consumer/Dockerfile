FROM golang:1.26-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o queue-consumer .

FROM alpine:3.24
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/queue-consumer /usr/local/bin/queue-consumer
ENTRYPOINT ["queue-consumer"]
