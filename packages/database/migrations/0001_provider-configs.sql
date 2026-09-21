CREATE TABLE `provider_configs` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`executable_path` text,
	`arguments` text DEFAULT '[]' NOT NULL,
	`base_url` text,
	`default_model` text,
	`credential_reference` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
