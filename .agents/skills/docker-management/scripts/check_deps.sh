#!/bin/bash
# Check Docker dependencies

echo "🔍 Checking Docker dependencies..."

# Check Docker
if command -v docker &> /dev/null; then
    echo "  ✅ Docker installed: $(docker --version)"
else
    echo "  ❌ Docker not installed"
    echo "     Install: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check Docker Compose
if command -v docker-compose &> /dev/null; then
    echo "  ✅ Docker Compose installed: $(docker-compose --version)"
elif docker compose version &> /dev/null; then
    echo "  ✅ Docker Compose (plugin) installed: $(docker compose version)"
else
    echo "  ⚠️  Docker Compose not installed"
    echo "     Install: https://docs.docker.com/compose/install/"
fi

# Check Docker daemon
if docker info &> /dev/null; then
    echo "  ✅ Docker daemon running"
else
    echo "  ❌ Docker daemon not running"
    echo "     Start: sudo systemctl start docker"
    exit 1
fi

echo ""
echo "📊 Summary:"
echo "  ✅ Docker OK"
echo "  ✅ Docker daemon running"

exit 0
