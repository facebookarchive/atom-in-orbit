# atom-in-orbit

The goal of this project is to produce a version of Atom that runs in Chrome
from Atom's source that is as faithful to the desktop version as possible.

## Motivation

There are already [many offerings](https://www.slant.co/topics/713/~cloud-ides)
that provide a browser-based IDE: do we really need another one? There are two
questions here:

1. Why would someone want a browser-based IDE instead of a desktop one?
2. Assuming we're convinced we want an IDE in the browser, why should we prefer
Atom over exisitng offerings?

Many of the advantages of a web-based IDE aren't specific to IDEs, but to
webapps, in general:

* Zero setup / barrier to entry.
* Everything is stored to the cloud, so we can access it from anywhere, it is
automatically backed up, etc.
* It is inherently cross-platform.
* It is generally fair to assume the user is online while using the app.
* Unlike native apps, users do not need to "download" the entire webapp before
  using it. Webapps lend themselves to incremental updates by judicious use
  of the browser cache.
* Webapps can be used effectively from machines with limited resources because
  most of the "heavy lifting" is done on the server.
* Keeping the bulk of information on the server in a datacenter as opposed to
  spreading it across a multitude of clients in the wild generally makes it
  easier to secure.
* Inherent support for deep-linking into the application.
* Simplified release process: all users are always on the same version, which is
  the latest and greatest.

Admittedly, there is no reason why a desktop IDE cannot exhibit these
properties, thereby providing the same advantages of web-based IDEs, but it is
generally a bit more work.

In terms of **Why Atom?**, here are a few reasons:

* **Extensibility.** Atom has built up a rich developer ecosystem around it with
[thousands of packages](https://atom.io/packages).
* **Many of us are already using it!** If you are a power user of Atom, but you
want the option of using it as a webapp for the reasons listed above, wouldn't
it be nice to use the same tool on the web as on the desktop rather than
learning yet another editor? Don't you want to take all of your keyboard
shortcuts, themes, and other customizations with you?
* **Designed with fewer constraints.** When you design something as a webapp,
it's natural for the limitations of the browser to constrain your thinking.
Fortunately, Atom does not suffer from that. For example, Atom implements
certain libraries in C instead of JavaScript where it makes sense, which is not
something your average web developer would consider doing. Being desktop-first
is also reflected in the Atom community in that they have provided many packages
to support the development of mobile/desktop software, which is unlikely to be a
priority for those supporting a web-only IDE.

Nuclide's support for remote development is a compelling example of combining
the best features of desktop and web-based IDEs. All services in Nuclide are
written using the [Nuclide service framework](
https://github.com/facebook/nuclide/wiki/Remote-Nuclide-Services), which ensures
that features that are designed for local development will automatically work
the same way when used as part of remote development in Nuclide. For example,
consider the [Flow language service](https://nuclide.io/docs/languages/flow/) in
Nuclide, which provides autocomplete, click-to-symbol, diagnostics, and other
language features when editing Flow-typed JavaScript code. The service can
assume that it is running local to the JavaScript code it is servicing while
Nuclide takes care of proxying the requests and responses to the user's local
instance of Nuclide. (Effectively, local development is just a special case
where Nuclide and the service are running on the same machine.)
In this way, from a single codebase, Nuclide can
simultaneously support offline, local development on a beefy laptop in addition
to the "thin client" model that users expect from a webapp when editing remote
files.

Given Nuclide's ability to straddle the line between desktop and web, why would
we go back to the browser? Again, the list of advantages of webapps over native
apps is substantial, and even if we could theoretically achieve 100% parity from
a technical perspective, **changing user expectations around webapps vs. native
apps remains a challenge**. For this reason, it seems worth providing Atom as
both a desktop app and a webapp to broaden its appeal.

## Challenges

This project aims to run Atom in the browser. Because Atom is [mostly]
built using web technologies, much of its code can be run in the browser
verbatim. However, there is a number of "freedoms" that Atom-on-the-desktop
enjoys that Atom-in-the-browser does not:

* Synchronous access to the filesystem via the `fs` module.
* All resources are available locally and are assumed to be cheap to access.
* Natively implemented dependencies.
* Unrestricted access to the internet.
* Access to native APIs.

Fortunately, there are workarounds to all of these issues with some clever
engineering.

### Synchronous Access to the Filesystem

Initial experiments have shown [BrowserFS](https://github.com/jvilk/BrowserFS)
to be a powerful shim for `fs` in the browser.

### Cheap Access to Resources

A key challenge of this project is that of *packaging*.
Initially, we have been using [browserify](http://browserify.org/) to build the
prototype, but it produces a webapp that has to download 30MB of JavaScript
before it runs any code, so clearly we need a more sophisticated solution.

### Natively Implemented Dependencies

The plan is to use [Emscripten](http://kripken.github.io/emscripten-site/), but
this has not been put to the test yet.

### Unrestricted Access to the Internet

On the desktop, you can perform any sort of I/O you like and can access the
Internet however you want. By comparison, in the browser, all you have are
`XMLHttpRequest` and `WebSocket`. In general, and you are subject to the
same-origin policy, though maybe if you're lucky you can use [CORS](
https://developer.mozilla.org/en-US/docs/Web/HTTP/Access_control_CORS).

When designing a webapp, one could provide true "unrestricted" access to the
Internet via an open redirect on your server, but that is not a good choice from
a security perspective. Realistically, your IDE should not need "unrestricted"
access, but a deliberate server API that proxies requests, as necessary.

### Access to Native APIs

Because Atom runs in Electron, it is able to do things like configure the
window's native menu bar and context menu items. Admittedly, these have to be
faked in the browser by rebuilding the native UI using DOM elements.

## Building the Webapp

First, you must create a `config.local.json` file in the root of your project
with some configuration information. Specifically, it needs the location of a
[source checkout of Atom](https://github.com/atom/atom) that has been built at
the revision specified in the `config.json` file.

```
{
  "ATOM_SRC": "/home/mbolin/code/atom"
}
```

You can build the local demo by running (this takes 10s on my Linux box):

```
$ npm run build
```

(Unfortunately, the build script currently leaves a local change to
`src/compile-cache.js` in `ATOM_SRC`. This is lame -- I will fix the build
process!)

Assuming the build script succeeds, open `out/testpage.html` in Google Chrome
and you should see Atom running in the browser. If you open the Chrome Dev
Tools, you will see that the global `atom` has been installed and you can play
with it just like you can in the Dev Tools in Atom itself. For example, try
running the following in Chrome Dev Tools:

```
atom.config.set('core.themes', ['atom-light-ui', 'atom-light-syntax']);
atom.config.set('core.themes', ['atom-dark-ui', 'atom-dark-syntax']);
atom.notifications.addInfo('Wow, this really works!');
```

The list of Atom packages that is currently included by the demo is conservative
because the JavaScript is already so large. The list is specified in
`scripts/build.js`, so feel free to play with it and add more packages by
default.
