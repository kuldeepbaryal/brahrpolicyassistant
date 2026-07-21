import { config, isMockMode } from "@/lib/config";
import { HomeClient } from "./HomeClient";

export default function Home() {
  // Public, non-secret config passed to the client at render time.
  const clientId = isMockMode() ? "" : (() => {
    try {
      return config.oauthClientId;
    } catch {
      return "";
    }
  })();

  return (
    <HomeClient
      clientId={clientId}
      hostedDomain={config.allowedHostedDomain}
      mockMode={isMockMode()}
    />
  );
}
