// routers/UsersRoutes.js
import { Router } from "express";
import { supabase } from "../utils/supabase.js"; // adjust path if yours differs

const router = Router();

/**
 * POST /users/login
 * Body: { email: string, password: string }
 *
 * - Signs user in via Supabase Auth
 * - Fetches the user's Profile record
 * - Returns profile + minimal auth info
 */
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      data: null,
      error: null,
      message: "Email and password are required",
    });
  }

  try {
    // 1) Auth: sign in
    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email: String(email).trim(),
        password: String(password),
      });

    if (authError) {
      const msg = authError.message || "Unable to login";

      // Common Supabase cases:
      // - invalid credentials → 401
      // - email not confirmed → 403
      const isUnverified =
        msg.toLowerCase().includes("email not confirmed") ||
        msg.toLowerCase().includes("confirm your email");

      return res.status(isUnverified ? 403 : 401).json({
        success: false,
        data: null,
        error: authError,
        code: isUnverified ? "UNVERIFIED" : "INVALID_CREDENTIALS",
        message: isUnverified
          ? "Please verify your email before logging in."
          : "Invalid email or password.",
        email: String(email).trim(),
      });
    }

    const userId = authData?.user?.id;
    if (!userId) {
      return res.status(500).json({
        success: false,
        data: null,
        error: null,
        message: "Login succeeded but user id was missing.",
      });
    }

    // 2) Fetch profile
    // Adjust table name + column names to match your schema:
    // Common options:
    // - "profiles" with id = auth user id
    // - "employees" with user_id = auth user id
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (profileError) {
      return res.status(404).json({
        success: false,
        data: null,
        error: profileError,
        message: "Logged in, but could not find a profile for this user.",
      });
    }

    // 3) Return profile
    return res.status(200).json({
      success: true,
      data: {
        user_id: userId,
        // tokens if you want them (be careful where you store these on web)
        access_token: authData?.session?.access_token || null,
        refresh_token: authData?.session?.refresh_token || null,
        profile,
      },
      error: null,
      message: "Login successful",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      data: null,
      error: err,
      message: err?.message || "Server error",
    });
  }
});

export default router;
