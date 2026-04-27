# PACER Group — KPI & Dashboard Metrics Specification

## 1. EXECUTIVE DASHBOARD

### 1A. Financial Summary
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Total Revenue | SUM of all QBO income accounts | QBO P&L | Monthly |
| Total COGS | SUM of all QBO COGS accounts | QBO P&L | Monthly |
| Gross Profit | Revenue - COGS | QBO P&L | Monthly |
| Gross Margin % | Gross Profit / Revenue | QBO P&L | Monthly |
| Operating Expenses | SUM of all QBO Expense accounts | QBO P&L | Monthly |
| Net Income | Gross Profit - OpEx | QBO P&L | Monthly |
| Net Margin % | Net Income / Revenue | QBO P&L | Monthly |
| Revenue per Employee | Revenue / active team count | QBO + Supabase | Monthly |
| EBITDA | Net Income + Dep + Interest + Taxes | QBO P&L | Monthly |

### 1B. Revenue Breakdown
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| BIB Revenue | 3G + 5G + Delivery Fees | QBO invoice lines | Monthly |
| Gas Revenue | CO2 + Mixed/Nitro + Hazmat | QBO invoice lines | Monthly |
| Equipment Sales | Melt + other equipment invoices | QBO invoices | Monthly |
| Equipment Rental | Monthly rental income | QBO invoices | Monthly |
| Service Revenue | Break/fix + PM + Freshpet + Reman | QBO invoice lines | Monthly |
| Packaged Beverage | Alameda Soda can sales | QBO invoice lines | Monthly |
| Shopify DTC | Net sales - discounts + shipping | QBO invoices | Monthly |
| Revenue by Entity | Brix/AS vs FreeFlow split | QBO P&L by entity | Monthly |

### 1C. AR & Cash Health
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Total AR Outstanding | SUM(balance) WHERE balance > 0 | QBO invoices | Daily |
| AR Aging: Current | Due date >= today | QBO invoices | Daily |
| AR Aging: 1-30 days | Due date 1-30 days past | QBO invoices | Daily |
| AR Aging: 31-60 days | Due date 31-60 days past | QBO invoices | Daily |
| AR Aging: 61-90 days | Due date 61-90 days past | QBO invoices | Daily |
| AR Aging: 90+ days | Due date > 90 days past | QBO invoices | Daily |
| DSO (Days Sales Outstanding) | AR / (Revenue / 30) | QBO invoices + P&L | Monthly |
| Stale Invoices | SF jobs with $$ but no QBO invoice > 5 days | SF + QBO cross-ref | Daily |
| Stale Invoice $$ at Risk | SUM(sf_total) of stale jobs | SF + QBO | Daily |

### 1D. Customer Analytics
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Top 20 Customers by Revenue | SUM(total_amount) grouped by customer | QBO invoices | Monthly |
| Customer Concentration % | Top N customers as % of total revenue | QBO invoices | Monthly |
| Revenue per Account | Total revenue / active customer count | QBO invoices | Monthly |
| Customer Growth | New customers this period vs last | QBO invoices | Quarterly |
| Revenue Growth per Account | Period-over-period per customer | QBO invoices | Quarterly |

### 1E. Labor Cost Structure
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Total Payroll | SUM(annual_wage) for all active team members | Supabase roster | Monthly |
| Delivery Labor | SUM(wage) WHERE dept = delivery | Supabase roster | Monthly |
| Service Labor | SUM(wage) WHERE dept = service | Supabase roster | Monthly |
| Reman Labor | SUM(wage) WHERE dept = reman | Supabase roster | Monthly |
| Shared/Ops Labor | SUM(wage * split_pct) WHERE dept = ops | Supabase roster | Monthly |
| Labor as % of Revenue | Total payroll / Revenue | Supabase + QBO | Monthly |
| Delivery COGS (QBO) | QBO Account 1150040011 | QBO P&L | Monthly |
| Service COGS (QBO) | QBO Account 1150040012 | QBO P&L | Monthly |
| Reman COGS (QBO) | QBO Account 1150040013 | QBO P&L | Monthly |

---

## 2. DELIVERY DRIVERS

Team: Joaquin Onate ($46K), Kyle McGee ($43K). COGS: 1150040011.

### 2A. Cost Allocation
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Cost per Stop | Daily labor cost / stops completed | Roster + SF | Daily |
| Cost per Case Delivered | Route cost / total units | Roster + QBO lines | Weekly |
| Delivery Cost as % of Rev | Total delivery labor / delivery revenue | Roster + QBO | Monthly |
| 3rd Party Delivery Cost | QBO Account 349 | QBO P&L | Monthly |

### 2B. Revenue Attribution
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Revenue per Stop | BIB + Gas + Can rev / total stops | QBO lines + SF | Daily |
| Margin per Stop | Revenue/stop - Cost/stop | Calculated | Daily |
| Revenue per Driver per Day | Total delivery rev / (drivers * days) | QBO + Roster | Monthly |
| Revenue per Mile | Delivery revenue / total miles | QBO + Fleetmatics | Daily (future) |
| BIB Revenue by Driver | Invoice line rev by driver's stops | QBO lines + SF | Monthly |
| Gas Revenue by Driver | CO2 + mixed gas by driver | QBO lines + SF | Monthly |
| Can Revenue by Driver | Packaged bev by driver | QBO lines + SF | Monthly |

### 2C. Activity & Productivity
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Stops per Day | COUNT(delivery_stops) by driver, date | SF | Daily |
| Stops per Route Day | Total stops / working days | SF | Weekly |
| Average Time at Stop | AVG(departure - arrival) | SF (future) | Daily |
| Route Days Worked | COUNT(DISTINCT stop_date) | SF | Monthly |
| Delivery Exceptions | Shorts, returns, refused | SF | Daily |
| Dead Runs | Stops with zero invoice amount | SF + QBO | Weekly |
| On-Time Delivery % | Stops within window / total | SF (future) | Daily |

### 2D. Fleet / Vehicle (Fleetmatics - Phase 3)
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Miles per Day | GPS miles per driver | Fleetmatics | Daily |
| Miles per Stop | Miles / stops | Fleetmatics + SF | Daily |
| Idle Time % | Idle min / total engine-on min | Fleetmatics | Daily |
| Fuel Cost per Mile | Fuel spend / miles | Fleetmatics | Weekly |
| First Departure Time | First vehicle movement | Fleetmatics | Daily |
| Route Adherence | Planned vs actual sequence | SF + Fleetmatics | Daily |
| Hard Braking Events | Count of events | Fleetmatics | Daily |
| Speed Violations | Count of speeding events | Fleetmatics | Daily |

---

## 3. SERVICE TECHNICIANS

Team: Eric VanRenselaar ($55K), Rene Benavides ($52K), Anthony VanRenselaar ($72K). COGS: 1150040012.

### 3A. Cost Allocation
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Cost per Job | Daily labor cost / jobs completed | Roster + SF | Daily |
| Cost per Billable Hour | Daily labor cost / billable hours | Roster + SF | Daily |
| Service Labor as % of Svc Rev | Service payroll / service revenue | Roster + QBO | Monthly |
| Parts Cost per Job | Total parts / job count | SF (future) | Monthly |
| Fully Loaded Cost per Job | (Labor + parts + vehicle) / jobs | All sources | Monthly |

### 3B. Revenue Attribution
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Revenue per Job | Service revenue / total jobs | QBO + SF | Monthly |
| Margin per Job | Revenue/job - Cost/job | Calculated | Monthly |
| Revenue per Tech per Day | Service rev / (techs * days) | QBO + Roster | Monthly |
| Revenue per Tech per Month | Grouped by tech_name | QBO + SF | Monthly |
| PM Contract Revenue | QBO Account 303 | QBO P&L | Monthly |
| Break/Fix Revenue | QBO Account 35 | QBO P&L | Monthly |
| Freshpet Revenue | QBO Account 255 | QBO P&L | Monthly |

### 3C. Productivity & Quality
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Jobs per Tech per Day | COUNT by tech, date | SF | Daily |
| Billable Utilization % | Billable hours / total paid hours | SF + Payroll | Weekly |
| First-Time Fix Rate | No callback / total | SF | Monthly |
| Callback / Rework Rate | Callback jobs / total | SF | Monthly |
| Avg Response Time | Dispatch to arrival (min) | SF (future) | Daily |
| Avg Time on Site | Duration (min) | SF | Daily |
| Open WO Aging | Days open for incomplete jobs | SF | Daily |
| PM Coverage % | PM hours / total svc hours | SF | Monthly |
| Non-Invoiced Jobs | Completed with sf_total=0 | SF | Weekly |
| Non-Invoiced $$ at Risk | sf_total > 0, no QBO match > 5d | SF + QBO | Daily |

---

## 4. REMAN / EQUIPMENT REMANUFACTURING

Team: Robert Nadell ($47K), Jermaene Feliciano ($44K), Andrade ($37K). COGS: 1150040013.

### 4A. Cost & Margin
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Labor per Unit | Reman labor cost / units completed | Roster + SF | Monthly |
| Parts per Unit | QBO Account 254 / units | QBO + SF | Monthly |
| Fully Loaded Cost per Unit | Labor + parts + overhead | Calculated | Monthly |
| Revenue per Unit | Reman revenue / units | QBO + SF | Monthly |
| Margin per Unit | Revenue - Cost per unit | Calculated | Monthly |
| Reman Margin % | Margin / Revenue per unit | Calculated | Monthly |

### 4B. Throughput & Efficiency
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Units Completed per Month | COUNT complete reman_jobs | SF | Monthly |
| Units per Tech | Grouped by tech_name | SF | Monthly |
| Avg Turnaround Days | AVG(completion - intake) | SF | Monthly |
| WIP Count | Status = in_progress | SF | Daily |
| Backlog Depth | Status = intake | SF | Daily |
| Scrap / Yield Rate | Scrapped / total intake | SF | Monthly |

### 4C. Quality
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Return / Defect Rate | Returns / total completed | SF + QBO | Monthly |
| Warranty Claims | Claims on reman units | SF + QBO | Monthly |

---

## 5. SALES & ACCOUNT MANAGEMENT

### 5A. Pipeline (Zoho CRM - Phase 4)
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Pipeline Value by Stage | SUM(amount) by stage | Zoho CRM | Weekly |
| New Accounts Won | New customers this period | Zoho CRM | Monthly |
| Win Rate | Won / total opportunities | Zoho CRM | Monthly |
| Avg Deal Size | AVG(amount) won deals | Zoho CRM | Monthly |
| Pipeline Velocity | Avg days lead to close | Zoho CRM | Monthly |
| Lead Response Time | Hours to first contact | Zoho CRM | Weekly |

### 5B. Account Health (QBO - Live)
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Revenue per Account | SUM(total_amount) per customer | QBO | Monthly |
| Gross Margin per Account | Revenue - COGS per customer | QBO | Monthly |
| Customer Churn Rate | Invoiced last period but not this | QBO | Quarterly |
| Upsell Revenue | New product lines into existing | QBO lines | Quarterly |
| AR Aging per Account | Balance + overdue by customer | QBO | Weekly |
| Cost-to-Serve per Account | Delivery + service cost per customer | SF + Roster | Monthly |
| Account Profitability Rank | Revenue - costs, ranked | All sources | Monthly |

### 5C. Retention
| KPI | Formula | Source | Frequency |
|---|---|---|---|
| Customer Lifetime Value | Avg monthly rev * avg tenure | QBO | Quarterly |
| Revenue Growth by Account | This period vs last year | QBO | Quarterly |
| At-Risk Accounts | Revenue declining > 20% QoQ | QBO | Quarterly |
| Customer Concentration Risk | Top 5 as % of total revenue | QBO | Monthly |

---

## 6. AUTOMATED ALERTS

| Alert | Trigger | Source | Schedule |
|---|---|---|---|
| Stale Invoice | SF job $$ > 5d, no QBO match | SF + QBO | Daily 7am PT |
| AR Overdue | Invoice > 30d past due | QBO | Weekly (future) |
| Large Invoice | New invoice > $10K | QBO | Real-time (future) |
| Sync Failure | Edge function error | sync_log | On failure (future) |
| New Customer | First invoice for new name | QBO | Daily (future) |
| Driver Idle | Idle > 30 min | Fleetmatics | Real-time (future) |
| Zero-Revenue Day | Driver worked, $0 invoiced | SF + QBO | Daily (future) |

---

## 7. ROSTER MANAGEMENT

Dashboard CRUD for ops.team_members:
- Add member (name must match SF tech name)
- Edit role, department, wage, entity, COGS account
- Deactivate (preserve history)
- Swap department (auto-updates COGS mapping)
- View job history per person
- View cost allocation per person per period

### Department → COGS Mapping
| Department | QBO Account ID | Account Name |
|---|---|---|
| delivery | 1150040011 | B2B - Direct Labor (COGS) |
| service | 1150040012 | Service - Direct Labor (COGS) |
| reman | 1150040013 | Reman - Direct Labor (COGS) |
| ops (shared) | 1150040007 | Direct Labor |

---

**Total: 108 KPIs across 5 departments + 7 automated alerts + roster CRUD**

Generated April 27, 2026. Use with PACER-OPS-ARCHITECTURE.md as the complete build spec for Claude Code.
