import { createClient } from "@/lib/client";
import { BACKEND_URL } from "@/lib/config";
import type { User } from "@supabase/supabase-js";
import axios from "axios";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

const supabase = createClient();

export default function Dashboard() {

    const navigate = useNavigate();
    const [user, setUser] = useState<User | null>(null);
    useEffect(() => {
        async function getUser() {
            const { data, error } = await supabase.auth.getUser();
            if (data.user) {
                setUser(data.user);
            }
        }
        getUser();
    }, [])


    useEffect(() => {
        async function getExistingConversations() {
        if(user) {
            const {data: {session}} = await supabase.auth.getSession();
            const jwt = session?.access_token
            const response = await axios.get(`${BACKEND_URL}/conversations`, {
                headers: {
                    Authorization: jwt
                }
            })
            console.log(response.data);
        }
    }
    getExistingConversations();
    }, [user]);

    return (
        <div>
            {!user && <button onClick={() => navigate("/auth")}>Sign In</button>}
            {user && <div>
                {user.email}

                <button onClick={() => { supabase.auth.signOut(); navigate("/auth"); }}>Logout</button>
            </div>
            }
        </div>
    );
}