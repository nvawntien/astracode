-- Native header_mutation removes untrusted identity before this script.
-- Native RBAC requires sanitized=true before ANY request reaches an upstream.
function envoy_on_request(handle)
  local headers = handle:headers()
  local api = headers:get(":path"):sub(1, 5) == "/api/"
  handle:streamInfo():dynamicMetadata():set("astracode.edge", "options", api and headers:get(":method") == "OPTIONS")
  for _, name in ipairs({"x-user-id", "x-role", "x-username", "x-token-iat",
      "x-client-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
      "x-forwarded-port", "x-forwarded-client-cert", "x-real-ip", "forwarded"}) do
    headers:remove(name)
  end
  local remove = {}
  for name, _ in pairs(headers) do
    if name:sub(1, 8) == "x-envoy-" then table.insert(remove, name) end
  end
  for _, name in ipairs(remove) do headers:remove(name) end
  local peer = handle:streamInfo():downstreamDirectRemoteAddress()
  local ip = peer:match("^%[([^%]]+)%]:%d+$") or peer:match("^(.*):%d+$")
  if ip then headers:replace("x-client-ip", ip) end

  -- One credential only. Never let extractor iteration order select identity.
  -- Public login/refresh and ticket-authenticated SSE keep their own contract.
  if handle:metadata():get("protected") then
    local cookies, authorizations = 0, 0
    for name, value in pairs(headers) do
      if name == "cookie" then
        for part in value:gmatch("[^;]+") do
          if part:match("^%s*access_token%s*=") then cookies = cookies + 1 end
        end
      elseif name == "authorization" then
        authorizations = authorizations + 1
        -- Envoy may coalesce duplicate HTTP/1 Authorization fields with ','.
        if value:find(",", 1, true) then authorizations = authorizations + 1 end
      end
    end
    if cookies > 1 or authorizations > 1 or (cookies > 0 and authorizations > 0) then
      handle:respond({[":status"] = "401"}, "")
      return
    end
  end

  -- Preserve the old per-endpoint query allowlists without decoding/re-encoding
  -- values (including repeated keys, '+' and percent-encoded data).
  local allowed = handle:metadata():get("query")
  if allowed and allowed[1] ~= "*" then
    local path = headers:get(":path")
    local base, query = path:match("^([^?]*)%?(.*)$")
    if query then
      local names, kept = {}, {}
      for _, name in ipairs(allowed) do names[name] = true end
      for pair in query:gmatch("[^&]+") do
        local key = pair:match("^([^=]*)")
        key = key:gsub("%+", " "):gsub("%%(%x%x)", function(hex)
          return string.char(tonumber(hex, 16))
        end)
        if names[key] then table.insert(kept, pair) end
      end
      headers:replace(":path", base .. (#kept > 0 and "?" .. table.concat(kept, "&") or ""))
    end
  end

  local input = handle:metadata():get("input_headers")
  if input then
    local names, remove = {}, {}
    for _, name in ipairs(input) do names[string.lower(name)] = true end
    for name, _ in pairs(headers) do
      if name:sub(1, 1) ~= ":" and not names[name] then table.insert(remove, name) end
    end
    for _, name in ipairs(remove) do headers:remove(name) end
  end
  handle:streamInfo():dynamicMetadata():set("astracode.edge", "sanitized", true)
end

function envoy_on_response(handle)
  local metadata = handle:streamInfo():dynamicMetadata():get("astracode.edge")
  if metadata and metadata.options and handle:headers():get(":status") == "200" then
    -- The previous CORS middleware answered preflight with 204.
    handle:headers():replace(":status", "204")
    handle:headers():remove("content-length")
  end
end
