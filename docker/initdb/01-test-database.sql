-- A second database for the integration suite.
--
-- The tests create and drop schema freely and assert on exact row counts, so
-- they must never share a database with whatever you are working on. Keeping
-- them apart means `pnpm test` can never eat your data.
--
-- Runs once, on first initialisation of the volume.
CREATE DATABASE rsc_editor_test OWNER rsc;
