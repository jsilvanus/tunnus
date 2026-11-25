
## TODO: Future Work & Planned Capabilities

### 1. Centralized Phone Calls / Telephony Service (Voice)
- **Goal:** Centralize outbound phone calls / automated voice notifications in Tunnus (alongside Email, SMS, Web Push, and Webhooks).
- **Use Cases:**
  - Emergency alerts / critical parish notifications.
  - Urgent shift change alerts when SMS or email is unacknowledged.
  - Automated voice reminders for accessibility or landlines.
- **Technical Considerations:**
  - Provider integration (e.g., Twilio Voice, Brevo Voice API, or SIP trunk).
  - Rate limiting, quiet-hours enforcement, and consent management.
  - Unified relay endpoint: `POST /api/voice/call` with text-to-speech (TTS) script or audio template.
