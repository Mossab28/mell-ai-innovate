-- Follow restaurant replies on Mell's inbox and watch Booking prices without booking.
ALTER TABLE watches DROP CONSTRAINT watches_source_check;
ALTER TABLE watches ADD CONSTRAINT watches_source_check
  CHECK (source IN ('doctolib', 'sncf', 'thefork', 'booking', 'weather', 'mail', 'mell_mail', 'web'));
