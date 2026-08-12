#!/usr/bin/env bash
# Bootstraps the VM. Run by gcp-setup.sh over SSH (it scp's this + env.vm.example to /tmp).
# Installs Docker, swap, and Artifact Registry auth; scaffolds /opt/irises/.env with everything
# it can derive (you only add API keys); and installs a systemd unit so the stack returns on boot.
set -euo pipefail

META="http://metadata.google.internal/computeMetadata/v1"
mdq(){ curl -s -H "Metadata-Flavor: Google" "$META/$1"; }

PROJECT_ID="$(mdq project/project-id)"
VM_IP="$(mdq instance/network-interfaces/0/access-configs/0/external-ip)"
ZONE_FULL="$(mdq instance/zone)"; ZONE="${ZONE_FULL##*/}"; REGION="${ZONE%-*}"
AR_HOST="${REGION}-docker.pkg.dev"
IMAGE="${AR_HOST}/${PROJECT_ID}/irises/irises:latest"
echo ">> VM detected: project=${PROJECT_ID} ip=${VM_IP} region=${REGION}"

echo ">> Installing Docker Engine + Compose plugin..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker

echo ">> Adding a 2G swapfile (OOM cushion for the 1 GB e2-micro)..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo ">> Ensuring gcloud + Artifact Registry docker auth (as root; the deploy runs sudo docker)..."
if ! command -v gcloud >/dev/null 2>&1; then
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list >/dev/null
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  sudo apt-get update -y && sudo apt-get install -y google-cloud-cli
fi
sudo gcloud auth configure-docker "$AR_HOST" --quiet
command -v docker-credential-gcloud >/dev/null 2>&1 || echo "WARN: docker-credential-gcloud not on PATH — Artifact Registry pulls may fail."

echo ">> Scaffolding /opt/irises/.env (only API keys are left for you to fill)..."
sudo install -d -m 0755 /opt/irises
if [ ! -f /opt/irises/.env ]; then
  TOKEN_KEY="$(openssl rand -base64 32)"
  PUSH_TOKEN="$(openssl rand -hex 24)"
  sudo cp /tmp/env.vm.example /opt/irises/.env
  sudo sed -i \
    -e "s|^IMAGE=.*|IMAGE=${IMAGE}|" \
    -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${VM_IP}.nip.io|" \
    -e "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://${VM_IP}.nip.io|" \
    -e "s|^GOOGLE_OAUTH_REDIRECT_URI=.*|GOOGLE_OAUTH_REDIRECT_URI=https://${VM_IP}.nip.io/oauth/google/callback|" \
    -e "s|^TOKEN_ENCRYPTION_KEY=.*|TOKEN_ENCRYPTION_KEY=${TOKEN_KEY}|" \
    -e "s|^GMAIL_PUSH_VERIFY_TOKEN=.*|GMAIL_PUSH_VERIFY_TOKEN=${PUSH_TOKEN}|" \
    /opt/irises/.env
  sudo chmod 600 /opt/irises/.env
  echo "   wrote /opt/irises/.env (IMAGE, SITE_ADDRESS, URLs, TOKEN_ENCRYPTION_KEY, and GMAIL_PUSH_VERIFY_TOKEN filled in)"
fi

# Seed the committed config (the deploy overwrites /opt/irises/app.env on every push).
[ -f /tmp/app.env ] && sudo install -m 0644 /tmp/app.env /opt/irises/app.env

echo ">> Installing a systemd unit so the stack comes back after a reboot..."
sudo tee /etc/systemd/system/irises.service >/dev/null <<'UNIT'
[Unit]
Description=Irises (docker compose)
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/irises
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable irises >/dev/null 2>&1 || true

echo ">> Bootstrap complete. Add your API keys (sudo nano /opt/irises/.env), then push to main."
