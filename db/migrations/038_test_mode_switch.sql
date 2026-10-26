-- Test mode is now one admin switch at /admin/settings (app_settings key 'test_mode'), with no
-- server env gate. While on, the cross-pump fraud check is off and fraud alert and location
-- approval emails are logged instead of sent.
-- The old key 'fraud_check_disabled' only worked while the server env TEST_MODE=true; a value
-- left behind in a database that ran without it must not turn into test mode, so it is removed.
DELETE FROM app_settings WHERE key = 'fraud_check_disabled';
