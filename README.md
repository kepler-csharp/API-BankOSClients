# BankOS Proxy

Microservicio Node.js que reemplaza la API Laravel conectándose **directamente a PostgreSQL**.
Expone exactamente los mismos endpoints que consume la app Flutter sin modificar una sola línea de Flutter.

---

## Despliegue en el VPS (donde ya corre bankos_db)

### 1. Sube los archivos al VPS

```bash
scp -r bankos-proxy/ usuario@87.99.154.103:/opt/bankos-proxy
```

### 2. Averigua el nombre de la red Docker donde corre bankos_db

```bash
docker inspect bankos_db | grep -A5 '"Networks"'
```
Copia el nombre de la red (ej: `bankos_network`, `bridge`, etc.)  
Edita `docker-compose.yml` y pon ese nombre en `bankos_net.external.name` si difiere.

### 3. Levanta el proxy

```bash
cd /opt/bankos-proxy
docker compose up -d --build
```

### 4. Verifica que corre

```bash
curl http://localhost:3000/health
# → {"status":"ok","ts":"..."}

curl http://localhost:3000/api/v1/banks
# → {"success":true,"data":[{"id":"test-bank","name":"..."},...]}
```

### 5. Abre el puerto 3000 en el firewall

```bash
ufw allow 3000/tcp
```

---

## Configuración de Flutter

En `lib/core/constants/app_config.dart` el `defaultValue` ya apunta a `https://bank-os.duckdns.org/api/v1`.  
Solo cambia la URL a la del proxy:

**Opción A — cambiar el default directamente** (desarrollo rápido):
```dart
static const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://87.99.154.103:3000/api/v1',  // ← solo esto
);
```

**Opción B — pasar en tiempo de compilación** (recomendado):
```bash
flutter run --dart-define=API_BASE_URL=http://87.99.154.103:3000/api/v1
```

> Si tienes dominio con HTTPS usa `https://` y configura un reverse proxy (nginx/caddy) en el VPS apuntando al puerto 3000.

---

## Estructura de la DB esperada

El proxy asume la estructura que ya creó Laravel/stancl:

**bankos_central:**
- `tenants` → columnas: `id` (varchar), `data` (jsonb con `name`)
- `domains` → columnas: `domain`, `tenant_id`

**tenant_{id}** (ej: `tenant_test-bank`):
- `users` → `id, name, email, password (bcrypt), role, created_at, updated_at`
- `accounts` → `id, user_id, account_number, balance, currency, status, created_at, updated_at`
- `transactions` → `id, type, status, account_id, destination_account_id, amount, converted_amount, currency, destination_currency, fee, balance_after, description, created_at, updated_at`
- `pqrs` → `id, user_id, type, subject, message, status, admin_response, created_at, updated_at` (se crea automáticamente si no existe)

---

## Variables de entorno disponibles

| Variable  | Default         | Descripción               |
|-----------|-----------------|---------------------------|
| `PORT`    | `3000`          | Puerto del proxy          |
| `DB_HOST` | `87.99.154.103` | Host de PostgreSQL        |
| `DB_PORT` | `5433`          | Puerto de PostgreSQL      |
| `DB_USER` | `bankos`        | Usuario de PostgreSQL     |
| `DB_PASS` | `secret`        | Contraseña de PostgreSQL  |

Con Docker Compose usando red interna, `DB_HOST=bankos_db` y `DB_PORT=5432` (puerto interno).

---

## Notas

- **Sesiones**: en memoria (se pierden al reiniciar el proxy). Para persistencia usa Redis.
- **Código de retiro**: se loguea en consola del proxy. Integra un servicio de email real si necesitas enviarlo.
- **PQRS**: si la tabla no existe en el tenant DB, el proxy la crea automáticamente al primer uso.
