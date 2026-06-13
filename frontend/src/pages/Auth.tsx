import { createClient } from "@/lib/client";

const supabase = createClient();

export default function Auth() {

    async function login(provider: "google" | "github") {
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: provider,
        });

        if (error) {
            console.error("Error logging in:", error);
        } else {
            console.log("Login successful:", data);
        }
    }

    return (
        <div>
            <button onClick={() => login("google")}>Login with Google</button>
            <button onClick={() => login("github")}>Login with GitHub</button>
        </div>
    );
}