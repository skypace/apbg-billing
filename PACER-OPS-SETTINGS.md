# PACER Ops Dashboard — Settings & Alert Configuration

## Settings Tables (ops schema)

### ops.alert_settings
Dashboard-managed alert configuration. The edge functions read from this table — no hardcoded recipients or schedules.

```
id              bigint PK
alert_type      text UNIQUE    -- 'stale_invoice', 'ar_overdue', 'large_invoice', 'sync_failure', 'zero_revenue_day'
enabled         boolean        -- toggle on/off from dashboard
recipients      jsonb          -- ["skypace@brixbev.com", "sam@freeflowbev.com"]
schedule        text           -- cron expression or "daily", "weekly", "realtime", "on_failure"
config          jsonb          -- alert-specific config
last_sent_at    timestamptz    -- when the alert last fired
created_at, updated_at timestamptz
```

**Config field per alert type:**
| Alert | Config Keys |
|---|---|
| stale_invoice | lookback, from_email, from_name |
| ar_overdue | threshold_days, min_amount, from_email, from_name |
| large_invoice | threshold_amount, from_email, from_name |
| sync_failure | from_email, from_name |
| zero_revenue_day | from_email, from_name |

**Current seed data:**
- stale_invoice: ENABLED, daily 7am PT, to skypace@brixbev.com
- ar_overdue: DISABLED (ready to enable)
- large_invoice: DISABLED
- sync_failure: DISABLED
- zero_revenue_day: DISABLED

### ops.dashboard_settings
General key-value config for the dashboard app.

```
key     text PK
value   jsonb
```

**Current keys:**
- company: {name, entities, timezone}
- sf_job_url_base: "https://admin.servicefusion.com/jobs/jobView?id="
- resend_from: "alerts@alamedapointbg.com"

## Dashboard Settings Page Requirements

### Alert Management UI
- List all alert_settings rows as cards
- Toggle enabled/disabled per alert
- Edit recipients (add/remove email addresses)
- Edit schedule (dropdown: daily, weekly, custom cron)
- Edit config thresholds (e.g., stale days, min amount)
- Show last_sent_at timestamp
- "Test Now" button that calls the edge function with dry_run=true
- "Send Now" button that calls without dry_run

### General Settings
- Company name, entities, timezone
- SF job URL base
- Default from email for alerts
- Resend API status check

### Sync Status Monitor
- Read from ops.sync_log to show:
  - Last successful QBO sync (time, records)
  - Last successful SF sync (time, records, last_page_processed)
  - Last stale alert sent (time, counts)
  - Any recent errors
- "Force Sync Now" buttons for QBO and SF

### Service Fusion Job URL Pattern
SF uses encoded IDs for job view URLs. The pattern is:
- API returns: `printable_work_order[0].url` contains `jobId={encoded_hash}`
- View URL: `https://admin.servicefusion.com/jobs/jobView?id={encoded_hash}`
- Stored in: `sf_encoded_id` column on delivery_stops, service_jobs, reman_jobs
- Fallback: `https://admin.servicefusion.com/#!/jobs/{numeric_id}`

### Cron Jobs (pg_cron) — viewable in settings
| Name | Schedule | What |
|---|---|---|
| backfill-invoice-lines | */3 * * * * | QBO line items backfill |
| nightly-qbo-sync | 0 9 * * * | QBO current month |
| sf-job-sync | */30 * * * * | SF jobs with tech names |
| stale-invoice-alert | 0 14 * * * | Weekly uninvoiced jobs email |
