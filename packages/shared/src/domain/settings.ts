import { z } from "zod";

export const themeSchema = z.enum(["system", "dark", "light"]);
export type Theme = z.infer<typeof themeSchema>;

export const densitySchema = z.enum(["comfortable", "compact"]);
export type Density = z.infer<typeof densitySchema>;

/** Application settings. Dark mode first (spec §110). */
export const appSettingsSchema = z.object({
  theme: themeSchema,
  density: densitySchema,
  /** Developer Mode exposes raw normalized events and logs (spec §111). */
  developerMode: z.boolean(),
  defaultProviderId: z.string().min(1).nullable(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  theme: "system",
  density: "comfortable",
  developerMode: false,
  defaultProviderId: null,
};

export const updateSettingsInputSchema = appSettingsSchema.partial();
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;
