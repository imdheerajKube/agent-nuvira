---
name: kubernetes
description: Configure and manage Kubernetes clusters. Use when the goal asks to deploy, scale, or manage containerized applications on Kubernetes.
version: 2.0.0
whenToUse: Container orchestration, microservices deployment, auto-scaling, rolling updates, service mesh setup
whenNotToUse: Simple Docker Compose (single host), serverless-only workloads, static site hosting
---

# Kubernetes

Configure and manage Kubernetes clusters with production patterns.

## Goal pattern

kubernetes k8s cluster pod deployment service ingress helm

## Parameters

- tool (choice [default: kubectl]): K8s management tool
- ingressController (choice [default: nginx]): Ingress controller
- serviceMesh (choice [default: none]): Service mesh

## Steps

### Step 1: [context-gatherer] — Analyze cluster and workload requirements

```bash
# Check cluster status
kubectl cluster-info
kubectl get nodes -o wide
kubectl get namespaces

# Check resource capacity
kubectl top nodes
kubectl describe nodes | grep -A 5 "Allocated resources"

# Check existing workloads
kubectl get pods --all-namespaces | grep -v kube-system
```

- What workloads? (web apps, workers, stateful sets, cronjobs)
- What resources needed? (CPU, memory, GPU, storage)
- What networking? (Service mesh, Ingress, NetworkPolicy)
- What storage? (PV/PVC, StorageClass, local vs network)
- What security? (RBAC, PodSecurityPolicy, NetworkPolicy)

### Step 2: [writer] — Create Kubernetes manifests

**Deployment with best practices:**
```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  namespace: production
  labels:
    app: myapp
    version: v1.2.3
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
        version: v1.2.3
    spec:
      serviceAccountName: myapp
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 2000
      containers:
        - name: myapp
          image: myregistry/myapp:v1.2.3
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "512Mi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: myapp-secrets
                  key: database-url
```

**Service and Ingress:**
```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp
  namespace: production
spec:
  selector:
    app: myapp
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP

---
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/rate-limit: "100"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
    - hosts:
        - myapp.example.com
      secretName: myapp-tls
  rules:
    - host: myapp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: myapp
                port:
                  number: 80
```

**HPA for auto-scaling:**
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### Step 3: [runner] — Deploy and configure

```bash
# Apply manifests
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml

# Verify deployment
kubectl get pods -n production -w
kubectl rollout status deployment/myapp -n production

# Check HPA
kubectl get hpa -n production

# Test service
kubectl port-forward svc/myapp 8080:80 -n production
curl http://localhost:8080/healthz

# View logs
kubectl logs -f deployment/myapp -n production --tail=100
```

### Step 4: [reviewer] — Verify cluster health

```bash
# Check all resources
kubectl get all -n production

# Verify pods are healthy
kubectl get pods -n production -o wide | grep -v Running

# Check events for warnings
kubectl get events -n production --sort-by='.lastTimestamp' | grep -i warning

# Verify resource usage
kubectl top pods -n production

# Test rolling update
kubectl set image deployment/myapp myapp=myregistry/myapp:v1.2.4 -n production
kubectl rollout status deployment/myapp -n production
```

**Verification checklist:**
- [ ] All pods in Running/Ready state
- [ ] HPA scaling works under load
- [ ] Liveness/readiness probes configured
- [ ] Resource limits set (no unlimited pods)
- [ ] Network policies restrict traffic
- [ ] Secrets encrypted at rest
- [ ] Rolling updates complete without downtime
- [ ] Ingress serves traffic with TLS

## Reference Documents

Load deep-dive content with `skill_view('kubernetes', 'references/k8s-patterns.md')`.
