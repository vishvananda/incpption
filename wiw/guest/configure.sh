set -eu
mkdir -p /tmp/plan-input /tmp/browser-replay
tar -xf /mnt/plan/batch.tar -C /tmp/plan-input
cp /mnt/plan/capture.py /mnt/plan/replay.py /tmp/
cp /mnt/plan/prepare.py /mnt/plan/capture-and-export.py /tmp/browser-replay/
chmod +x /tmp/capture.py
if [ -f /mnt/plan/wasi-sdk.tar ]; then
    mkdir -p /tmp/will-wasi/Platform
    tar -xf /mnt/plan/wasi-sdk.tar -C /tmp/will-wasi
    cp /mnt/plan/wasi-probe.bin /tmp/will-wasi/cppgm
    chmod +x /tmp/will-wasi/cppgm
    cp /mnt/plan/wasi_toolchain.cmake /tmp/will-wasi/
    cp /mnt/plan/WASI.cmake /tmp/will-wasi/Platform/
    export PLAN_TARGET=wasm32-wasip1
fi
export PLAN_MODE=trace
exec python3 /tmp/browser-replay/capture-and-export.py /tmp/plan-input /mnt/plan
