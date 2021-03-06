import { getAssetFromKV } from "@cloudflare/kv-asset-handler";
import cookie from "cookie";
import jose from "node-jose";
import { seal } from "tweetsodium";

import { hydrateEdgeState } from "./edge_state";

const cookieKey = "Authed-User";

addEventListener("fetch", (event) => {
  try {
    event.respondWith(handleEvent(event));
  } catch (e) {
    event.respondWith(new Response(e.toString(), { status: 500 }));
  }
});

async function handleEvent(event) {
  const { request } = event;
  const url = new URL(request.url);

  console.log("=== URL PATH ===", url.pathname);

  if (url.pathname === "/button") {
    const buttonPath = `deploy.svg`;
    return await getAssetFromKV(event, {
      mapRequestToAsset: (req) =>
        new Request(`${new URL(req.url).origin}/${buttonPath}`, req),
    });
  }

  if (url.pathname === "/callback") {
    return handleCallback(event);
  }

  if (url.pathname === "/secret") {
    return handleSecret(event);
  }

  if (url.pathname === "/user") {
    return handleUser(event);
  }

  if (url.pathname === "/verify") {
    return handleVerifyCf(event);
  }

  
  if(url.pathname === "/login"){
    const { accessToken, authed, error, redirectUrl } = await validateCookie(
      event
    );
  
    // redirect to homepage if user is authed already
    console.log("*** AFTER Validation: url.pathname: ", url.pathname);
    console.log("----------- LOGIN?? -----------");
    console.log("- event: ", event);
    console.log("- AUTH: ", authed);
    console.log("- url.origin: ", url.origin);
    console.log("- redirectUrl: ", redirectUrl);
    console.log("- accessToken: ", accessToken);
    console.log("- error: ", error);

    if (authed) {
      return Response.redirect(`${url.origin}/`)
    }
    
    if (!authed && redirectUrl) {
      return Response.redirect(redirectUrl);
    }
  }

  const { accessToken, authed, error, redirectUrl } = await validateCookie(
    event
  );



  return renderApp(event, { error, state: { accessToken, authed } });
}

const handleSecret = async (event) => {
  try {
    const headers = event.request.headers;
    const body = await event.request.json();
    console.log("Secret:", body);
    if (body.repo && body.secret_key && body.secret_value) {
      const keyResp = await fetch(
        `https://api.github.com/repos/${body.repo}/actions/secrets/public-key`,
        { headers }
      );
      const keyRespJson = await keyResp.json();
      const { key, key_id } = keyRespJson;
      const encrypted = seal(
        Buffer.from(body.secret_value),
        Buffer.from(key, "base64")
      );
      const encrypted_value = Buffer.from(encrypted).toString("base64");
      const secretResp = await fetch(
        `https://api.github.com/repos/${body.repo}/actions/secrets/${body.secret_key}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            encrypted_value,
            key_id,
          }),
        }
      );
      return new Response(null, { status: secretResp.status });
    } else {
      return new Response(null, { status: 400 });
    }
  } catch (err) {
    return new Response(err.toString());
  }
};

const handleUser = async (event) => {
  const { accountId, apiToken, email } = await event.request.json();
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    {
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': apiToken,
        "Content-type": "application/json",
      },
    }
  );

  const result = await resp.json();
  const username = result.result.subdomain;
  console.log("USERNAME:", username);
  return new Response(JSON.stringify(username), { status: resp.status });
};



const validateCookie = async (event) => {

  
  const redirectUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&scope=public_repo`;
  let authed = false
  
  console.log("------ VALIDAT COOKIE -----");
  console.log("AUTHED: ", authed);
  console.log("redirectUrl: ", redirectUrl);
  console.log("CLIENT_ID:", CLIENT_ID);
  console.log("CLIENT_SECRET:", CLIENT_SECRET);

  try {
    console.log("=== TRYING");
    const { request } = event;
    console.log("- request:", request);
    
    const cookieHeader =
    request.headers.get("Cookie") || request.headers.get("Set-cookie") || ""; // cookie.parse accepts string only, undefined throws error
    console.log("- cookieHeader:", cookieHeader);
    console.log("- requestHeaders:", request.headers);

    const cookies = cookie.parse(cookieHeader);
    console.log("- cookies:", cookies);

    const auth = cookies[cookieKey];
    console.log("- auth:", auth);

    if (!auth) {
      console.log("=== if !auth");
      const jsonData = {
        authed: false,
        redirectUrl,
      };
      console.log(jsonData);

      return jsonData;
    }

    authed = true
    console.log("=== authed:", authed);

    const jsonKey = await AUTH_STORE.get(`keys:${auth}`, { type: 'json' });
    console.log("- jsonKey:", jsonKey);
    
    const key = await jose.JWK.asKey(jsonKey);
    console.log("- key:", key);
    
    const storedAuth = await AUTH_STORE.get(`auth:${auth}`, { type: 'json' });
    const { payload } = await jose.JWE.createDecrypt(key).decrypt(storedAuth)

    const { access_token: accessToken } = JSON.parse(payload);

    const tokenResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${accessToken}`,
        "User-Agent": "Deploy-to-CF-Workers",
      },
    });

    if (tokenResp.status > 201) {
      throw new Error("GitHub API response was invalid");
    }
    return { accessToken, authed };
  } catch (error) {
    return { authed, error };
  }
};

const handleCallback = async (event) => {
  const url = new URL(event.request.url);
  const code = url.searchParams.get("code");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
    }),
  });

  const result = await response.json();

  if (result.error) {
    return Response.redirect(url.origin);
  }

  const key = await jose.JWK.createKey("oct", 256, { alg: "A256GCM" });
  const jsonKey = key.toJSON(true);
  await AUTH_STORE.put(`keys:${jsonKey.kid}`, JSON.stringify(jsonKey), {
    expirationTtl: 3600,
  });

  const encrypted = await jose.JWE.createEncrypt(key)
    .update(JSON.stringify(result))
    .final();

  await AUTH_STORE.put(`auth:${jsonKey.kid}`, JSON.stringify(encrypted), {
    expirationTtl: 3600,
  });

  const headers = {
    Location: url.origin + `?authed=true`,
    "Set-cookie": `${cookieKey}=${jsonKey.kid}; Max-Age=3600; Secure; HttpOnly; SameSite=Lax;`,
  };

  return new Response(null, {
    headers,
    status: 301,
  });
};

const handleVerifyCf = async (event) => {
  const { accountId, apiToken, email } = await event.request.json();
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
    {
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': apiToken,
        "Content-type": "application/json",
      },
    }
  );
  return new Response(null, { status: resp.status });
};

const renderApp = async (event, { error = null, state = {} }) => {
  let options = {};
  try {
    const response = await getAssetFromKV(event, options);
    if (error) {
      response.headers.set("Set-cookie", "Authed-User=null; Max-Age=0");
    }
    return hydrateEdgeState({ response, state });
  } catch (e) {
    let notFoundResponse = await getAssetFromKV(event, {
      mapRequestToAsset: (req) =>
        new Request(`${new URL(req.url).origin}/404.html`, req),
    });

    return new Response(notFoundResponse.body, {
      ...notFoundResponse,
      status: 404,
    });
  }
};
