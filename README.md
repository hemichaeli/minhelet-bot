# Minhelet Bot

**WhatsApp appointment scheduling bot for Pinuy-Binuy residents**

## What it does

1. **Campaign management** — Create campaigns for specific compounds/buildings, send WhatsApp messages to residents
2. **Bot conversation** — Handle resident replies (confirm / decline / reschedule) in Hebrew and Russian
3. **Visual booking** — Send residents a booking link to choose their appointment slot
4. **Appointment types** — Appraiser visit / Surveyor visit / Signing ceremony / Consultation
5. **Reminders** — Automatic reminders 24h and 2h before appointments
6. **Fallback** — Escalate unresponsive residents to human agent after N attempts

## Architecture

```
Zoho CRM (residents / buildings / compounds — read only)
        ↓
Minhelet Bot (this repo)
        ↓
INFORU CAPI → WhatsApp (Minhelet business line)
        ↓
Resident replies → Bot handles conversation
        ↓
Google Calendar / Zoho Calendar ← Appointment booked
```

## Data sources

- **Zoho CRM**: Residents, buildings, compounds — read via Zoho API (no local copy)
- **Local DB (Railway PostgreSQL)**: Campaigns, bot sessions, bookings, reminders

## Environment Variables

See `.env.example` for all required variables.

## Deploy on Railway

1. Connect this repo to Railway
2. Set all env vars from `.env.example`
3. Railway will auto-deploy on every push to `main`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health check |
| POST | `/api/campaigns` | Create a new scheduling campaign |
| GET | `/api/campaigns` | List all campaigns |
| GET | `/api/booking/:token` | Resident booking page (HTML) |
| POST | `/api/booking/confirm` | Confirm appointment slot |
| GET | `/api/appointments` | List all appointments |
| POST | `/api/events` | Create event (signing ceremony etc.) |
