"use client";

import { useEffect, useState } from "react";
import { api, type PublicUser } from "@/lib/client";
import { LoginScreen } from "@/components/LoginScreen";
import { ChatApp } from "@/components/ChatApp";

export function HomeClient({
  clientId,
  hostedDomain,
  mockMode,
}: {
  clientId: string;
  hostedDomain: string;
  mockMode: boolean;
}) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMe().then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  const signOut = async () => {
    await api.signOut();
    setUser(null);
  };

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center" style={{ background: "var(--bg)" }}>
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="typing-dot h-2 w-2 rounded-full"
              style={{ background: "var(--color-brand-500)", animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen clientId={clientId} hostedDomain={hostedDomain} mockMode={mockMode} onSignedIn={setUser} />;
  }

  return <ChatApp user={user} onSignOut={signOut} />;
}
