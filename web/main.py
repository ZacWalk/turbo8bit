import os
from datetime import date
from urllib.parse import urlparse

from flask import (
    Flask,
    render_template,
    redirect,
    url_for,
    abort,
    session,
    request,
    Response,
    make_response,
)
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", os.urandom(24))

# Canonical public host. All SEO URLs (canonical, OG, sitemap) are built from
# this, and any request hitting a different host (e.g. the default
# *.appspot.com URL) is 301-redirected here so search engines only see one
# domain.
CANONICAL_HOST = os.environ.get("CANONICAL_HOST", "turbo8bit.com")
CANONICAL_SCHEME = os.environ.get("CANONICAL_SCHEME", "https")
CANONICAL_ORIGIN = f"{CANONICAL_SCHEME}://{CANONICAL_HOST}"

# Hosts that should NOT be redirected (local dev, health checks, etc.).
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0"}


@app.before_request
def _redirect_to_canonical_host():
    """301-redirect any non-canonical, non-local host to CANONICAL_HOST."""
    host = (request.host or "").split(":")[0].lower()
    if not host or host == CANONICAL_HOST or host in _LOCAL_HOSTS:
        return None
    # Preserve path + query string.
    target = f"{CANONICAL_ORIGIN}{request.full_path if request.query_string else request.path}"
    # request.full_path always appends '?' even with no query; trim it.
    if target.endswith("?"):
        target = target[:-1]
    return redirect(target, code=301)


def canonical_url_for(endpoint, **values):
    """Build an absolute URL on CANONICAL_HOST regardless of request host."""
    path = url_for(endpoint, **values)
    return f"{CANONICAL_ORIGIN}{path}"


def canonical_static_url(filename):
    """Absolute URL to a static asset on CANONICAL_HOST."""
    return canonical_url_for("static", filename=filename)


@app.context_processor
def inject_canonical():
    """Make canonical helpers available to all templates."""
    return {
        "CANONICAL_ORIGIN": CANONICAL_ORIGIN,
        "canonical_url_for": canonical_url_for,
        "canonical_static_url": canonical_static_url,
    }


# Google OAuth2 Client ID (set in environment or app.yaml)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")


def _safe_redirect_target(target):
    """Return target if it is a same-host relative URL, else the index URL.

    Prevents open-redirect attacks via attacker-supplied `next` values.
    """
    if not target:
        return url_for("index")
    parsed = urlparse(target)
    # Reject absolute URLs (any scheme or host) and protocol-relative URLs.
    if parsed.scheme or parsed.netloc:
        return url_for("index")
    if not target.startswith("/") or target.startswith("//"):
        return url_for("index")
    return target


def get_user_info():
    """Get the current logged-in user info from session."""
    return {
        "email": session.get("user_email"),
        "name": session.get("user_name"),
        "picture": session.get("user_picture"),
    }


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

        return redirect(_safe_redirect_target(request.form.get("next")))
    except Exception as e:
        # verify_oauth2_token can raise ValueError or google.auth exceptions.
        # Log details server-side; never echo them back to the client.
        app.logger.warning("Google token verification failed: %s", e)
        abort(401, "Invalid token")


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


@app.route("/about")
def about():
    """Render the about page."""
    return render_template("about.html")


# ---------------------------------------------------------------------------
# SEO: robots.txt and sitemap.xml
# ---------------------------------------------------------------------------

# Public, indexable routes paired with sitemap metadata.
# (endpoint, changefreq, priority)
SITEMAP_ROUTES = [
    ("index", "monthly", "1.0"),
    ("asm", "monthly", "0.9"),
    ("hardware", "monthly", "0.9"),
    ("memmap", "monthly", "0.9"),
    ("sid", "monthly", "0.9"),
    ("about", "yearly", "0.5"),
]


@app.route("/robots.txt")
def robots_txt():
    """Serve robots.txt allowing crawl of public pages."""
    sitemap_url = canonical_url_for("sitemap_xml")
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /auth/\n"
        "\n"
        f"Sitemap: {sitemap_url}\n"
    )
    return Response(body, mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap_xml():
    """Serve a sitemap.xml listing all public pages."""
    today = date.today().isoformat()
    urls = []
    for endpoint, changefreq, priority in SITEMAP_ROUTES:
        urls.append(
            {
                "loc": canonical_url_for(endpoint),
                "lastmod": today,
                "changefreq": changefreq,
                "priority": priority,
            }
        )
    xml = render_template("sitemap.xml", urls=urls)
    response = make_response(xml)
    response.headers["Content-Type"] = "application/xml"
    return response


if __name__ == "__main__":
    # This is used when running locally only. When deploying to Google App
    # Engine, a webserver process such as Gunicorn will serve the app. This
    # can be configured by adding an `entrypoint` to app.yaml.
    app.run(host="127.0.0.1", port=8082, debug=True)
