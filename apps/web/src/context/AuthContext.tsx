"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { UserDTO } from "@/types/auth";
import { getCurrentUser, logout as apiLogout } from "@/lib/api";

export type AuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

export interface AuthContextType {
  user: UserDTO | null;
  status: AuthStatus;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  const fetchUser = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const currentUser = await getCurrentUser();
      if (currentUser) {
        setUser(currentUser);
        setStatus("authenticated");
      } else {
        setUser(null);
        setStatus("unauthenticated");
      }
    } catch (err: unknown) {
      console.error("Auth verification failed:", err);
      setUser(null);
      setError(
        err instanceof Error ? err.message : "Failed to verify authentication."
      );
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const handleLogout = useCallback(async () => {
    try {
      await apiLogout();
    } catch (err) {
      console.warn("Backend logout warning:", err);
    } finally {
      setUser(null);
      setStatus("unauthenticated");
      setError(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        status,
        error,
        refresh: fetchUser,
        logout: handleLogout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
