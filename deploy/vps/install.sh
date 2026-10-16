#!/usr/bin/env bash
# Idempotent installer for the Arcana web + API host (static site + Node API behind Nginx).
# Run as root ON the server from a prepared release directory:
#   ARCANA_DOMAIN=app.example.com ACME_EMAIL=ops@example.com bash install.sh /path/to/release
# The release directory contains: site/ (the built `out/`), server/, functions/,
# node_modules/ (production), package.json, nginx.conf (rendered by scripts/vps/render-nginx.mjs).
# It never overwrites /etc/arcana/api.env and never prints secrets.
set -euo pipefail

RELEASE_SRC="${1:?usage: install.sh <release-dir>}"
DOMAIN="${ARCANA_DOMAIN:?set ARCANA_DOMAIN}"
ACME_EMAIL="${ACME_EMAIL:?set ACME_EMAIL}"
SHA="$(cat "$RELEASE_SRC/REVISION" 2>/dev/null || date +%Y%m%d%H%M%S)"
APP=/opt/arcana

if [ "$(id -u)" -ne 0 ]; then echo "run as root" >&2; exit 1; fi

. /etc/os-release
case "${ID_LIKE:-$ID}" in
  *rhel*|*fedora*|*centos*) PM=dnf ;;
  *debian*|*ubuntu*)        PM=apt ;;
  *) echo "unsupported OS: $ID" >&2; exit 1 ;;
esac

install_pkgs() {
  if [ "$PM" = dnf ]; then
    dnf -y install epel-release >/dev/null 2>&1 || true
    dnf -y module enable nodejs:22 >/dev/null 2>&1 || true
    dnf -y install nginx nodejs certbot firewalld policycoreutils-python-utils >/dev/null
  else
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nginx certbot ufw ca-certificates curl >/dev/null
    if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
      apt-get install -y -qq nodejs >/dev/null
    fi
  fi
}
install_pkgs
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node >= 22 required" >&2; exit 1; }

id arcana >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin arcana
install -d -o root -g arcana -m 0750 /etc/arcana
install -d -o arcana -g arcana -m 0755 "$APP" "$APP/releases"
install -d -m 0755 /var/www/acme

DEST="$APP/releases/$SHA"
rm -rf "$DEST"
cp -a "$RELEASE_SRC" "$DEST"
chown -R root:arcana "$DEST"
find "$DEST" -type d -exec chmod 0750 {} +
find "$DEST" -type f -exec chmod 0640 {} +
chmod 0755 "$DEST" "$DEST/site"
find "$DEST/site" -type d -exec chmod 0755 {} +
find "$DEST/site" -type f -exec chmod 0644 {} +

if [ ! -f /etc/arcana/api.env ]; then
  install -o root -g arcana -m 0640 "$DEST/api.env.example" /etc/arcana/api.env
  echo "created /etc/arcana/api.env from the template: fill in the secrets, then re-run" >&2
  exit 3
fi

install -m 0644 "$DEST/arcana-api.service" /etc/systemd/system/arcana-api.service
PREV="$(readlink -f "$APP/current" || true)"
ln -sfn "$DEST" "$APP/current.new" && mv -Tf "$APP/current.new" "$APP/current"
systemctl daemon-reload
systemctl enable arcana-api >/dev/null
systemctl restart arcana-api

# Health gate: roll back to the previous release if the new one does not become healthy.
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "new release unhealthy; rolling back" >&2
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then ln -sfn "$PREV" "$APP/current.new" && mv -Tf "$APP/current.new" "$APP/current" && systemctl restart arcana-api; fi
  journalctl -u arcana-api -n 30 --no-pager | sed -E 's/(key|secret|token|password)[^ ]*/\1=<redacted>/Ig' >&2
  exit 4
fi

# TLS: a temporary HTTP-only vhost serves the ACME challenge; certbot then issues the certificate.
CONF_DIR=/etc/nginx/conf.d
[ -d "$CONF_DIR" ] || { echo "nginx conf.d missing" >&2; exit 1; }
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  cat > "$CONF_DIR/arcana-acme.conf" <<EOF
server { listen 80; listen [::]:80; server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/acme; }
  location / { return 404; } }
EOF
  nginx -t && systemctl enable --now nginx && systemctl reload nginx
  certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" --email "$ACME_EMAIL" --agree-tos --non-interactive
  rm -f "$CONF_DIR/arcana-acme.conf"
fi

install -m 0644 "$DEST/nginx.conf" "$CONF_DIR/arcana.conf"
rm -f /etc/nginx/conf.d/default.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
if [ "$PM" = dnf ]; then
  command -v getsebool >/dev/null && setsebool -P httpd_can_network_connect 1 || true
  systemctl enable --now firewalld
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
fi
systemctl enable --now certbot-renew.timer 2>/dev/null || systemctl enable --now certbot.timer 2>/dev/null || true
echo "Arcana release $SHA is live on https://$DOMAIN (previous: ${PREV:-none})"
