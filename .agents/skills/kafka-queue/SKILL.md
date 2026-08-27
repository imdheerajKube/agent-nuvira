---
name: kafka-queue
description: Set up Kafka message queues. Use when the goal asks to add event streaming, message queues, or async processing with Kafka.
version: 2.0.0
whenToUse: Event streaming, async processing, log aggregation, real-time data pipelines, microservices communication
whenNotToUse: Simple task queues (use Redis), HTTP APIs (use api-creation), scheduled tasks (use cron-job)
---

# Kafka Queue

Set up Kafka message queues with enterprise patterns.

## Goal pattern

kafka message queue event streaming async processing producer consumer

## Parameters

- serialization (choice [default: json]): Message format
- partitioning (choice [default: key-based]): Partition strategy
- monitoring (boolean [default: true]): Monitor consumer lag

## Steps

### Step 1: [context-gatherer] — Analyze messaging requirements

```bash
# Check Kafka availability
kafka-topics --bootstrap-server localhost:9092 --list 2>/dev/null

# Check Docker Kafka
docker ps | grep kafka

# Check existing topics
kafka-topics --bootstrap-server localhost:9092 --describe 2>/dev/null | head -20
```

- What events? (user actions, system events, data changes)
- What throughput? (messages/sec, message size)
- What ordering? (per-partition, global)
- What retention? (hours, days, forever)

### Step 2: [writer] — Implement Kafka producers and consumers

**Producer:**
```python
# src/kafka/producer.py
from kafka import KafkaProducer
import json
from datetime import datetime

class EventProducer:
    def __init__(self, bootstrap_servers='localhost:9092'):
        self.producer = KafkaProducer(
            bootstrap_servers=bootstrap_servers,
            value_serializer=lambda v: json.dumps(v).encode('utf-8'),
            key_serializer=lambda k: k.encode('utf-8') if k else None,
            acks='all',  # Ensure durability
            retries=3,
            max_in_flight_requests_per_connection=1,  # Ordering
            compression_type='gzip'
        )
    
    def send_event(self, topic: str, key: str, event: dict):
        """Send event with key for partitioning."""
        event['timestamp'] = datetime.utcnow().isoformat()
        future = self.producer.send(topic, key=key, value=event)
        return future.get(timeout=10)
    
    def send_batch(self, topic: str, events: list):
        """Send batch of events."""
        for event in events:
            key = event.get('user_id') or event.get('order_id')
            self.producer.send(topic, key=str(key), value=event)
        self.producer.flush()

# Usage
producer = EventProducer()
producer.send_event('user-events', 'user-123', {
    'event_type': 'page_view',
    'page': '/products',
    'duration_ms': 5000
})
```

**Consumer:**
```python
# src/kafka/consumer.py
from kafka import KafkaConsumer
import json
from typing import Callable

class EventConsumer:
    def __init__(self, group_id: str, bootstrap_servers='localhost:9092'):
        self.consumer = KafkaConsumer(
            bootstrap_servers=bootstrap_servers,
            group_id=group_id,
            value_deserializer=lambda m: json.loads(m.decode('utf-8')),
            auto_offset_reset='earliest',
            enable_auto_commit=False,  # Manual commit for reliability
            max_poll_records=100,
            session_timeout_ms=30000
        )
    
    def consume(self, topics: list, handler: Callable):
        """Consume events with manual offset commit."""
        self.consumer.subscribe(topics)
        
        try:
            while True:
                messages = self.consumer.poll(timeout_ms=1000)
                for tp, msgs in messages.items():
                    for msg in msgs:
                        try:
                            handler(msg.value)
                            self.consumer.commit(tp)
                        except Exception as e:
                            print(f"Error processing message: {e}")
                            # Send to dead letter queue
                            self.send_to_dlq(msg)
        except KeyboardInterrupt:
            self.consumer.close()
    
    def send_to_dlq(self, message):
        """Send failed message to dead letter queue."""
        # Implementation for DLQ
        pass

# Usage
def handle_event(event):
    print(f"Processing: {event['event_type']}")

consumer = EventConsumer('my-consumer-group')
consumer.consume(['user-events'], handle_event)
```

### Step 3: [runner] — Deploy and test

```bash
# Create topics
kafka-topics --bootstrap-server localhost:9092 \
  --create --topic user-events \
  --partitions 6 \
  --replication-factor 3

# List topics
kafka-topics --bootstrap-server localhost:9092 --list

# Test producer
python -c "
from src.kafka.producer import EventProducer
producer = EventProducer()
for i in range(100):
    producer.send_event('user-events', f'user-{i}', {'event': 'test', 'i': i})
"

# Test consumer
python -c "
from src.kafka.consumer import EventConsumer
def handle(msg):
    print(f'Received: {msg}')
consumer = EventConsumer('test-group')
consumer.consume(['user-events'], handle)
"

# Check consumer lag
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group my-consumer-group
```

### Step 4: [reviewer] — Verify Kafka works

```bash
# Check topic stats
kafka-topics --bootstrap-server localhost:9092 \
  --describe --topic user-events

# Verify consumer lag
kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group my-consumer-group | grep -v "^$"

# Test message retention
kafka-configs --bootstrap-server localhost:9092 \
  --describe --entity-type topics --entity-name user-events

# Monitor throughput
kafka-run-class kafka.tools.GetOffsetShell \
  --broker-list localhost:9092 \
  --topic user-events \
  --time -1
```

**Verification checklist:**
- [ ] Topics created with correct partitions
- [ ] Producers send successfully
- [ ] Consumers receive and process messages
- [ ] Consumer lag stays low
- [ ] Dead letter queue handles failures
- [ ] Message ordering maintained
- [ ] Retention policy enforced
- [ ] Monitoring dashboards show metrics

## Reference Documents

Load deep-dive content with `skill_view('kafka-queue', 'references/guide.md')`.
