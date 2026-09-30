# Credit Control Desk: self-hosted app

This is the same Urja Products receivables dashboard, running on your own server so it can send reminders itself:

- **Email** through your SMTP account (Gmail/Google Workspace, Microsoft 365, Zoho, or any mail server)
- **WhatsApp** through the WhatsApp Business Platform (Meta Cloud API)
- **Voice AI calls** through OmniDim (`POST https://omnidim.io/api/v1/calls/dispatchCall`)

Your API keys stay on the server. The browser never receives them.

## 1. Run it

You need Node.js 18 or newer.

```bash
npm install
cp .env.example .env      # then edit .env: set ADMIN_PASSWORD and SESSION_SECRET
npm start                 # opens on http://localhost:3000
```

Sign in with the `ADMIN_USER` / `ADMIN_PASSWORD` from `.env`. The defaults are `admin` / `admin@123`. **Change them before going live.**

### With Docker

```bash
docker build -t credit-desk .
docker run -d --name credit-desk -p 3000:3000 --env-file .env -v credit-desk-data:/app/data credit-desk
```

### On Render / Railway / a VPS

- Start command: `npm start`. The app reads `PORT` from the environment.
- Attach a **persistent disk** and set `DATA_DIR` to it. Reports, settings, contacts and keys are stored there.
- Serve it over **HTTPS**. Hosting platforms do this for you; on a VPS, put Nginx or Caddy in front.

Health check: `GET /healthz`.

## 2. Connect the services

Open **Settings → Server & API keys** in the app. You can also set the same values in `.env`; values set in `.env` are locked in the screen.

| What | Where to get it |
|---|---|
| SMTP host, port, user, password | Your mail provider. For Gmail/Workspace use `smtp.gmail.com`, port 587, and an **app password**. |
| WhatsApp phone number ID and access token | Meta Business → WhatsApp Manager → API Setup. Create a **permanent (system user) token** with `whatsapp_business_messaging` permission. |
| OmniDim API key | OmniDim dashboard → API keys |

Then fill in the other Settings tabs:

- **Email**: sender name and address, reply-to, CC, and the reminder text.
- **WhatsApp**: template name, language and variable order.
- **Voice AI (OmniDim)**: your agent ID, the from-number ID if you have one, calling hours, and the instructions sent with each call.

Use **Send test email** to check SMTP.

### WhatsApp template (needed for the first message to a customer)

WhatsApp only allows **approved templates** for business-initiated messages. Create a *Utility* template in WhatsApp Manager, for example:

> **payment_reminder** (English)
> Dear {{1}}, this is a reminder from Urja Products Private Limited. An amount of {{2}} against invoice(s) {{3}} is pending, the oldest being {{4}} days overdue. Kindly release the payment and share the UTR details. Please ignore if already paid.

The default variable order in Settings is `{contact}|{total}|{invoice_list_short}|{oldest_days}`, which matches {{1}}–{{4}} above. Free-text mode only works within 24 hours of the customer messaging you.

### OmniDim agent

Every call sends these fields as `call_context`, and your agent's prompt in OmniDim should use them:

`purpose`, `company`, `customer_name`, `customer_code`, `contact_name`, `city`, `currency`, `total_due`, `total_due_text`, `invoice_count`, `oldest_days_overdue`, `invoices[]` (number, invoice_date, due_date, amount_due, days_overdue, po), `as_of`, `language`, `callback_number`, `instructions`.

Suggested agent goal: confirm who is speaking, remind them of the amount and invoices, and ask for a payment date. Record any promise, dispute or UTR in the call summary. Results appear in OmniDim's call logs.

### Microsoft Dynamics 365 Business Central (live data)

Instead of exporting and uploading the Customer Outstanding XML, the app can pull open customer ledger entries straight from Business Central (online), on request or on a schedule.

1. **Register an app** in Microsoft Entra ID (portal.azure.com → App registrations). Note the Application (client) ID and Directory (tenant) ID.
2. **API permissions** → Dynamics 365 Business Central → *Application permissions* → `API.ReadWrite.All` → Grant admin consent. Create a **client secret**.
3. In Business Central, open **Microsoft Entra Applications** → New → paste the client ID, set State = Enabled, and assign `D365 READ` and `D365 BASIC` for the company.
4. In Business Central, open **Web Services** → New → Object Type *Page*, Object ID `25` (Customer Ledger Entries), Service Name `CustomerLedgerEntries`, Published. This page provides Due Date and Remaining Amount, which the standard API v2.0 customerLedgerEntries endpoint does not.
5. In the app: **Settings → Business Central**, enter tenant ID, client ID, client secret, environment (e.g. `Production`), company name (e.g. `URJA-LIVE`), then **Test connection** and **Sync now**.

What a sync does:
- Reads all open entries with `$filter=Open eq true` plus any extra filter you set (e.g. `Customer_Posting_Group eq 'CNI'` if your web service includes that field), following OData paging.
- Reads customer email, phone and city from the API v2.0 `customers` endpoint (optional). These appear in customer contacts unless you have edited that customer's contacts.
- Saves the result as a new report dated today (India time by default, `REPORT_TZ` to change) and makes it the current report. It is listed in **Uploads** as "Business Central sync". Failures are listed there too, with the reason.
- **Automatic sync** runs every 1, 3, 6, 12 or 24 hours while the app is running.

All of these settings can also be set with `BC_*` variables in `.env` (see `.env.example`).

## 3. Daily use

1. Upload the Business Central *Customer Outstanding* XML, an Excel/CSV sheet or a PDF.
2. In **Pending-due alerts**, the Customers table or Ledger entries, use the icons on each row:
   - ✉ email
   - WhatsApp
   - ☎ AI call
3. Check the pre-drafted message and choose which invoices to include, then send.
4. Each send is logged in the customer's reminder history, and the customer is marked **Contacted**. The server also keeps an audit file at `data/outbox.log`.

### Printable reports

**Download report** on the Dashboard creates a branded PDF, *Customer Outstanding & Collections Report*: a cover page with your logo, colours and company name, then an executive summary, ageing analysis, movement since the last report, pending-due alerts, customer-wise outstanding, overdue invoice register, invoices due soon, and collection activity with promised payments. **Download PDF** on the CXO view creates a shorter *Executive Summary* with the same branded cover. Open the PDF to print it or share it.

### CXO view

A read-only executive page with only the key numbers: net receivable, overdue, critical, due soon, unapplied credits and reminders this week, each compared with the previous report. It also shows ageing, movement since the last report (cleared and new invoices), the trend across reports, top overdue exposures, promised payments and a feed of status updates.

### Company & branding

**Settings → Company & branding** sets the company name (also used for {company} in reminders), app name, department or tagline, login screen message, brand colour and logo (PNG, JPG, WebP or SVG up to 2 MB, resized automatically). The login screen shows the saved branding before anyone signs in; only these branding fields are public, never receivables data.

### Uploads

The **Uploads** menu is where you add new reports: drop a file or tap *Choose file*, check the preview and the report date, then import. The upload history below lists every attempt with its date and time, file, report date, entries, customers, net outstanding and result (imported, failed with the reason, cancelled, or deleted). From there you can show an older report on the dashboard or delete it; deleting keeps contacts and reminder logs.

### Customers section

The **Customers** tab lists every customer found in all your uploaded reports. Click a customer to see and edit their contact people, phone numbers (marked WhatsApp or primary) and email addresses (marked for reminders or primary), plus GSTIN and notes. Contact details appear only after you open a customer; lists and alerts don't show them. Business Central reports don't include email addresses, so add them here once.

### Activity log

The **Activity log** tab records every email, WhatsApp message and voice AI call with the date and time, who it went to, which invoices and amount it covered, and whether it succeeded or failed. Click a row to see the exact message or call instructions. You can filter by channel, result and date, and export to Excel.

### Links from the claude.ai dashboard

If you also use the claude.ai version, put this app's address in its **Settings → Server & API keys**. Its **Send from server** button then opens the same customer here (`/?open=CUSTOMER_NO&ch=email|wa|voice&kind=od|soon`). The customer must be in the latest report uploaded to this server.

## Security notes

- Change `ADMIN_PASSWORD`, set a long random `SESSION_SECRET`, and serve over HTTPS.
- There is one shared login. For separate users, put the app behind your company SSO or VPN, or ask for multi-user support.
- `data/config.json` holds any keys entered in the Settings screen (file mode 600). Back up the `data` folder, and keep it private.
