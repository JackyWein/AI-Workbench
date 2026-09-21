CREATE TABLE `provider_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`family` text NOT NULL,
	`label` text NOT NULL,
	`home` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_accounts_family_home` ON `provider_accounts` (`family`,`home`);