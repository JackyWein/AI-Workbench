CREATE TABLE `ssh_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`username` text NOT NULL,
	`auth` text NOT NULL,
	`credential_reference` text,
	`host_key_fingerprint` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `connection_id` text REFERENCES `ssh_connections`(`id`);
