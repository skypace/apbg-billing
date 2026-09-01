-- A vendor usually has more than one person you email: AP, dispatch, the
-- owner. Until now they all got crammed into contact_email as one
-- comma-separated string, which is what made the QuickBooks push fail —
-- PrimaryEmailAddr takes exactly ONE address and returns fault 2210
-- ("does not conform to the syntax rules of RFC 822") on anything else.
--
-- So contact_email stays the PRIMARY (one address, and the only one
-- QuickBooks ever receives) and everyone else lives here.
--
-- An array rather than email_2 / email_3 columns: the number of contacts is
-- not knowable in advance, and a fixed set of slots is exactly how you end up
-- with three addresses in the last one again.
alter table ops.vendors
  add column if not exists additional_emails text[] not null default '{}';

comment on column ops.vendors.additional_emails is
  'Extra contacts for this vendor beyond contact_email. Everyone here is copied on document-request emails. QuickBooks only ever receives contact_email — its PrimaryEmailAddr accepts a single address.';
