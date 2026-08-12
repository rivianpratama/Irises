#!/usr/bin/env bash
# One-time setup for the Irises VM. Run it from Cloud Shell, inside a clone of the
# repo (so the deploy/ files are available to copy to the VM). It does EVERYTHING:
# creates the GCP resources, bootstraps the VM, and wires the GitHub secret + variables.
#
#   gh auth login                 # once, so this can set the GitHub secret/variables for you
#   nano deploy/gcp-setup.sh      # edit the 5 values below
#   bash deploy/gcp-setup.sh
set -euo pipefail

# ===================== EDIT THESE =====================
PROJECT_ID="YOUR_PROJECT_ID"        # the client's GCP project id
REGION="us-central1"                # keep a free-tier region (us-central1/us-east1/us-west1)
ZONE="us-central1-a"
GITHUB_REPO="rivianpratama/Irises"
MACHINE="e2-micro"                  # free-tier eligible; use e2-small if the app gets RAM-tight
# ======================================================

REPO="irises"; VM_NAME="irises"
DEPLOY_SA="gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
VM_SA="irises-vm@${PROJECT_ID}.iam.gserviceaccount.com"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gcloud config set project "$PROJECT_ID"

echo ">> Enabling APIs..."
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com iap.googleapis.com iam.googleapis.com

echo ">> Artifact Registry repo..."
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --description="Irises images"

echo ">> Service accounts..."
gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 || gcloud iam service-accounts create gh-deployer --display-name="GitHub Actions deployer"
gcloud iam service-accounts describe "$VM_SA"     >/dev/null 2>&1 || gcloud iam service-accounts create irises-vm   --display-name="Irises VM runtime"

echo ">> Roles for the CI deployer (push images, manage + SSH the VM via IAP)..."
for ROLE in roles/artifactregistry.writer roles/compute.instanceAdmin.v1 roles/iap.tunnelResourceAccessor roles/compute.osLogin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role="$ROLE" >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$VM_SA" --member="serviceAccount:$DEPLOY_SA" --role="roles/iam.serviceAccountUser" >/dev/null

echo ">> Role for the VM runtime (pull images)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$VM_SA" --role="roles/artifactregistry.reader" >/dev/null

echo ">> Firewall (SSH only from IAP; web open)..."
gcloud compute firewall-rules describe allow-iap-ssh >/dev/null 2>&1 || gcloud compute firewall-rules create allow-iap-ssh --direction=INGRESS --action=allow --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=irises
gcloud compute firewall-rules describe allow-web     >/dev/null 2>&1 || gcloud compute firewall-rules create allow-web     --direction=INGRESS --action=allow --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=irises

echo ">> VM ($MACHINE, Debian 12)..."
if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --zone="$ZONE" --machine-type="$MACHINE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --service-account="$VM_SA" --scopes=cloud-platform \
    --tags=irises --boot-disk-size=30GB --boot-disk-type=pd-standard
fi

VM_IP="$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
[ -n "$VM_IP" ] || { echo "ERROR: VM has no external IP — aborting."; exit 1; }

echo ">> Bootstrapping the VM over IAP SSH (this also CONFIRMS the tunnel works before any CI run)..."
for i in $(seq 1 12); do
  if gcloud compute scp --tunnel-through-iap --zone="$ZONE" --quiet \
       "$SCRIPT_DIR/vm-bootstrap.sh" "$SCRIPT_DIR/env.vm.example" "$SCRIPT_DIR/app.env" "$VM_NAME:/tmp/"; then break; fi
  echo "   ...VM SSH not ready yet ($i/12); retrying in 15s"; sleep 15
done
gcloud compute ssh --tunnel-through-iap --zone="$ZONE" --quiet "$VM_NAME" --command "bash /tmp/vm-bootstrap.sh"

echo ">> Creating the CI deploy key..."
gcloud iam service-accounts keys create /tmp/gh-deployer-key.json --iam-account="$DEPLOY_SA"

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo ">> Wiring the GitHub secret + variables..."
  gh secret   set GCP_SA_KEY     --repo "$GITHUB_REPO" < /tmp/gh-deployer-key.json
  gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPO" --body "$PROJECT_ID"
  gh variable set GCP_REGION     --repo "$GITHUB_REPO" --body "$REGION"
  gh variable set GCP_ZONE       --repo "$GITHUB_REPO" --body "$ZONE"
  gh variable set GCP_VM_NAME    --repo "$GITHUB_REPO" --body "$VM_NAME"
  rm -f /tmp/gh-deployer-key.json
  GH_DONE=yes
else
  GH_DONE=no
fi

echo ""
echo "============================================================"
echo " VM ready.  External IP: ${VM_IP}   HTTPS host: ${VM_IP}.nip.io"
echo "============================================================"
if [ "$GH_DONE" = no ]; then
  echo "gh isn't logged in here. Run 'gh auth login' and re-run this script, OR set these yourself:"
  echo "  gh secret   set GCP_SA_KEY     --repo ${GITHUB_REPO} < /tmp/gh-deployer-key.json && rm -f /tmp/gh-deployer-key.json"
  echo "  gh variable set GCP_PROJECT_ID --repo ${GITHUB_REPO} --body ${PROJECT_ID}"
  echo "  gh variable set GCP_REGION     --repo ${GITHUB_REPO} --body ${REGION}"
  echo "  gh variable set GCP_ZONE       --repo ${GITHUB_REPO} --body ${ZONE}"
  echo "  gh variable set GCP_VM_NAME    --repo ${GITHUB_REPO} --body ${VM_NAME}"
fi
echo ""
echo "FINAL STEP — add your API keys to the VM, then deploy:"
echo "  gcloud compute ssh ${VM_NAME} --zone ${ZONE} --tunnel-through-iap --ssh-flag=\"-t\" --command 'sudo nano /opt/irises/.env'"
echo "    (fill ANTHROPIC_API_KEY, OPENROUTER_API_KEY, LINQ_API_TOKEN, LINQ_AGENT_BOT_NUMBERS)"
echo "  Then: git push origin main   →   visit https://${VM_IP}.nip.io/health"
