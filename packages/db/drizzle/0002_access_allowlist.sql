-- Sign-in allowlist. Existing accounts keep access (the default applies to
-- them); from now on an unknown Discord user is refused before a row is ever
-- written, and an invite is a row with discord_id 'invite:<username>'.
ALTER TABLE "users" ADD COLUMN "allowed" boolean DEFAULT true NOT NULL;