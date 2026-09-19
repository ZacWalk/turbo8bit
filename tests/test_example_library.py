"""Sample selection must follow the user's last choice, not network timing."""

import pytest

from tests.test_utils import (
    JS_STATIC_DIR,
    create_mini_racer_context,
    load_js_file,
    strip_es6_imports_exports,
)


@pytest.fixture
def examples():
    ctx = create_mini_racer_context()
    ctx.eval(strip_es6_imports_exports(load_js_file(JS_STATIC_DIR / "examples.js")))
    ctx.eval(
        """
        var requests = new Map();
        var fetch = url => new Promise((resolve, reject) => {
            requests.set(url, { resolve, reject });
        });
        var library = new ExampleLibrary('/index.json', '/samples/');
        library.byId.set('first', { id: 'first', file: 'first.bas' });
        library.byId.set('second', { id: 'second', file: 'second.bas' });
        var selected = null;
        var error = null;
        function choose(id) {
            library.select(id).then(result => {
                if (result) selected = result;
            }).catch(reason => { error = reason.message; });
        }
        function respond(file, source) {
            requests.get('/samples/' + file).resolve({
                ok: true, text: () => Promise.resolve(source)
            });
        }
        """
    )
    return ctx


def test_late_sample_response_cannot_replace_latest_choice(examples):
    ctx = examples
    ctx.eval("choose('first'); choose('second');")
    ctx.eval("respond('second.bas', '20 PRINT 2');")
    ctx.eval("respond('first.bas', '10 PRINT 1');")
    assert ctx.eval("selected.example.id") == "second"
    assert ctx.eval("selected.source") == "20 PRINT 2"


def test_latest_sample_failure_is_reported(examples):
    ctx = examples
    ctx.eval("choose('second');")
    ctx.eval("requests.get('/samples/second.bas').resolve({ok: false, status: 503});")
    assert "503" in ctx.eval("error")
    assert ctx.eval("selected === null")


def test_stale_sample_failure_does_not_replace_current_state(examples):
    ctx = examples
    ctx.eval("choose('first'); choose('second');")
    ctx.eval("respond('second.bas', '20 PRINT 2');")
    ctx.eval(
        "requests.get('/samples/first.bas').reject(new Error('Old request failed'));"
    )
    assert ctx.eval("selected.example.id") == "second"
    assert ctx.eval("error === null")


def test_unknown_sample_is_an_explicit_error(examples):
    ctx = examples
    ctx.eval("choose('missing');")
    assert ctx.eval("error") == "Unknown example 'missing'"
    assert ctx.eval("requests.size") == 0
