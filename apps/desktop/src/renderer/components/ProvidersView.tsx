import type { JSX } from "react";
import type { ProviderSummary } from "@ai-workbench/shared";

interface ProvidersViewProps {
  readonly providers: ProviderSummary[];
}

/**
 * Central provider screen (spec §19). Everything shown here comes from the
 * adapter itself: installation, authentication, models and capabilities.
 */
export function ProvidersView({ providers }: ProvidersViewProps): JSX.Element {
  return (
    <div className="view">
      <div className="view__inner">
        <h1 className="view__title">Providers</h1>

        <section>
          {providers.map((provider) => (
            <article className="provider-entry" key={provider.metadata.id}>
              <div className="provider-entry__head">
                <span className="provider-entry__name">
                  {provider.metadata.displayName}
                </span>
                <span className="row__meta">{installationLabel(provider)}</span>
              </div>

              {provider.metadata.description ? (
                <p className="field__description">{provider.metadata.description}</p>
              ) : null}

              <dl className="detail-list">
                <div className="detail">
                  <dt className="detail__label">Authentication</dt>
                  <dd className="detail__value">{authLabel(provider)}</dd>
                </div>
                <div className="detail">
                  <dt className="detail__label">Transport</dt>
                  <dd className="detail__value">
                    {provider.metadata.transportTypes.join(", ")}
                  </dd>
                </div>
                <div className="detail">
                  <dt className="detail__label">Models</dt>
                  <dd className="detail__value">
                    {provider.models.length === 0
                      ? "None reported"
                      : provider.models.map((model) => model.displayName).join(", ")}
                  </dd>
                </div>
                <div className="detail">
                  <dt className="detail__label">Usage</dt>
                  <dd className="detail__value">
                    {provider.usage
                      ? usageStateLabel(provider.usage.state)
                      : "Not reported"}
                  </dd>
                </div>
              </dl>

              <div className="tag-list">
                {provider.capabilities.supported.map((capability) => (
                  <span className="tag" key={capability}>
                    {capability}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

function installationLabel(provider: ProviderSummary): string {
  switch (provider.installation.state) {
    case "installed":
      return provider.installation.version
        ? `Installed · ${provider.installation.version}`
        : "Installed";
    case "notInstalled":
      return "Not installed";
    case "unsupported":
      return "Unsupported on this platform";
    default:
      return "Unknown";
  }
}

function authLabel(provider: ProviderSummary): string {
  switch (provider.auth.state) {
    case "authenticated":
      return provider.auth.accountLabel ?? "Connected";
    case "authenticationRequired":
      return "Sign-in required";
    case "authenticationExpired":
      return "Sign-in expired";
    case "notApplicable":
      return provider.auth.detail ?? "Not required";
    case "unsupported":
      return "Not supported";
    default:
      return "Unknown";
  }
}

function usageStateLabel(state: string): string {
  switch (state) {
    case "available":
      return "Reported by the provider";
    case "partial":
      return "Partially reported";
    case "estimated":
      return "Estimated";
    default:
      return "Unavailable";
  }
}
