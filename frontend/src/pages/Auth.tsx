import { createClient } from "@/lib/client";
import { Sparkles } from "lucide-react";

const supabase = createClient();

export default function Auth() {
    async function login(provider: "google" | "github") {
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: provider,
            options: {
                redirectTo: window.location.origin, // Directs back to Dashboard after login
            }
        });

        if (error) {
            console.error("Error logging in:", error);
        } else {
            console.log("Login session request created:", data);
        }
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-50 antialiased font-sans px-4">
            <div className="w-full max-w-sm border border-zinc-900 bg-zinc-900/20 backdrop-blur-md rounded-2xl p-8 shadow-2xl space-y-6 text-center">

                {/* Identity Headings */}
                <div className="space-y-2">
                    <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 text-teal-400 mb-2">
                        <Sparkles className="w-5 h-5" />
                    </div>
                    <h2 className="text-xl font-semibold tracking-tight text-zinc-100">Welcome to Insight Engine</h2>
                    <p className="text-xs text-zinc-500">Sign in to start researching and manage your conversation history.</p>
                </div>

                <div className="space-y-2 pt-2">
                    {/* Custom Google OAuth Button */}
                    <button
                        onClick={() => login("google")}
                        className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 text-sm font-medium rounded-lg transition shadow-sm"
                    >
                        {/* Minimal SVG Asset for Google icon branding */}
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                            <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                            <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                            <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                            <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                        </svg>
                        <span>Continue with Google</span>
                    </button>

                    {/* Custom GitHub OAuth Button */}
                    <button
                        onClick={() => login("github")}
                        className="mt-4 w-full flex items-center justify-center gap-2.5 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-sm font-medium rounded-lg transition"
                    >
                        <svg className="w-4 h-4 shrink-0" viewBox="0 0 1024 1024" fill="none" >
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z" transform="scale(64)" fill="#ffffff" />
                        </svg>

                        <span>Continue with GitHub</span>
                    </button>
                </div>

                <div className="text-[10px] text-zinc-600 pt-4 border-t border-zinc-900">
                    By signing in you agree to use our free-tier search allocations responsibly.
                </div>
            </div>
        </div>
    );
}