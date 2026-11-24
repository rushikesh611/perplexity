import dotenv from "dotenv";

dotenv.config({
    path: `${import.meta.dir}/.env`,
    override: process.env.NODE_ENV !== "production"
});
