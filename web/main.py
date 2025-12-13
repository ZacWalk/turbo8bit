import os
from functools import wraps

from flask import Flask, render_template, redirect, url_for, abort, session, request
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", os.urandom(24))

# Google OAuth2 Client ID (set in environment or app.yaml)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")

# Admin emails that have access to experimental features
ADMIN_EMAILS = os.environ.get("ADMIN_EMAILS", "").split(",")


def get_user_info():
    """Get the current logged-in user info from session."""
    return {
        "email": session.get("user_email"),
        "name": session.get("user_name"),
        "picture": session.get("user_picture"),
        "is_admin": session.get("user_email") in ADMIN_EMAILS,
    }


def is_admin():
    """Check if current user is an admin."""
    return session.get("user_email") in ADMIN_EMAILS


def admin_required(f):
    """Decorator to require admin access for a route."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not is_admin():
            abort(403)
        return f(*args, **kwargs)
    return decorated_function


@app.context_processor
def inject_user():
    """Inject user info into all templates."""
    return {
        "user": get_user_info(),
        "google_client_id": GOOGLE_CLIENT_ID,
    }


@app.route("/auth/google", methods=["POST"])
def google_auth():
    """Handle Google Sign-In callback."""
    token = request.form.get("credential")
    if not token:
        abort(400, "No credential provided")
    
    try:
        idinfo = id_token.verify_oauth2_token(
            token, google_requests.Request(), GOOGLE_CLIENT_ID
        )
        
        session["user_email"] = idinfo.get("email")
        session["user_name"] = idinfo.get("name")
        session["user_picture"] = idinfo.get("picture")
        
        return redirect(request.form.get("next", url_for("index")))
    except ValueError as e:
        abort(401, f"Invalid token: {e}")


@app.route("/auth/logout")
def logout():
    """Log out the current user."""
    session.clear()
    return redirect(url_for("index"))


@app.route("/")
def index():
    """Render the BASIC tutorial page."""
    return render_template("index.html")


@app.route("/asm")
def asm():
    """Render the 6502 Assembly Lab page."""
    return render_template("asm.html")


@app.route("/hardware")
def hardware():
    """Render the C64 hardware diagram page."""
    return render_template("hardware.html")


@app.route("/memmap")
def memmap():
    """Render the C64 memory map page."""
    return render_template("memmap.html")


@app.route("/sid")
def sid():
    """Render the SID chip information page."""
    return render_template("sid.html")


@app.route("/demo")
@admin_required
def demo():
    """Render the Walker Demo page (admin only)."""
    return render_template("demo.html")


@app.route("/about")
def about():
    """Render the about page."""
    return render_template("about.html")


if __name__ == "__main__":
    # This is used when running locally only. When deploying to Google App
    # Engine, a webserver process such as Gunicorn will serve the app. This
    # can be configured by adding an `entrypoint` to app.yaml.
    app.run(host="127.0.0.1", port=8082, debug=True)
