#!/bin/bash
# Met Mell en ligne sur Aiven : une base PostgreSQL, puis l'app construite depuis ce dépôt GitHub, la base branchée en DATABASE_URL.
# Usage : AIVEN_TOKEN=... ANTHROPIC_API_KEY=... aiven/deploy.sh
set -euo pipefail
API=https://api.aiven.io/v1
CLOUD=${CLOUD:-aws-eu-west-1}
REPO=${REPO:-mell-ai-innovate}
H=(-sS -H "Authorization: Bearer $AIVEN_TOKEN" -H "Content-Type: application/json")
PROJECT=${PROJECT:-$(curl "${H[@]}" $API/project | jq -r '.projects[0].project_name')}
ORG=$(curl "${H[@]}" $API/organizations | jq -r '.organizations[0].organization_id')
echo "projet $PROJECT, organisation $ORG"

if ! curl "${H[@]}" $API/project/$PROJECT/service/mell-pg | jq -e '.service' >/dev/null; then
  curl "${H[@]}" -X POST $API/project/$PROJECT/service -d "{\"service_name\":\"mell-pg\",\"service_type\":\"pg\",\"plan\":\"${PG_PLAN:-startup-4}\",\"cloud\":\"$CLOUD\"}" | jq -c '{name:.service.service_name,state:.service.state,error:.message}'
fi

VCS=$(curl "${H[@]}" $API/organization/$ORG/application/vcs-integrations | tee /tmp/aiven-vcs.json | jq -r '(.vcs_integrations // .integrations // .)[0] | (.vcs_integration_id // .id)')
REPOS=$(curl "${H[@]}" $API/organization/$ORG/application/vcs-integrations/$VCS/repositories)
RID=$(echo "$REPOS" | jq -r --arg r "$REPO" '[(.repositories // .)[] | select((.name // .full_name // "") | test($r))][0] | (.remote_repository_id // .id)')
URL=$(echo "$REPOS" | jq -r --arg r "$REPO" '[(.repositories // .)[] | select((.name // .full_name // "") | test($r))][0] | (.html_url // .url // .clone_url)')
echo "github $VCS, dépôt $RID ($URL)"

ADMIN=$(openssl rand -hex 16)
jq -n --arg vcs "$VCS" --arg rid "$RID" --arg url "$URL" --arg cloud "$CLOUD" --arg key "$ANTHROPIC_API_KEY" --arg admin "$ADMIN" '{
  service_name: "mell", service_type: "application", cloud: $cloud, plan: "startup-50-1024",
  user_config: { application: {
    source: { vcs_integration_id: $vcs, remote_repository_id: $rid, repository_url: $url, branch: "main", build_path: "./", containerfile_path: "Dockerfile" },
    ports: [ { name: "http", port: 8080, protocol: "HTTP" } ],
    environment_variables: [
      { key: "ANTHROPIC_API_KEY", value: $key, kind: "secret" },
      { key: "MELLA_ADMIN_TOKEN", value: $admin, kind: "secret" },
      { key: "MELLA_MODEL", value: "claude-sonnet-5-5", kind: "variable" },
      { key: "MELLA_PULSE", value: "0", kind: "variable" }
    ] } },
  service_integrations: [ { integration_type: "application_service_credential", source_service: "mell-pg",
    user_config: { service_type: "pg", exposed_values: { connection_string: { environment_variable_key: "DATABASE_URL" } } } } ]
}' > /tmp/aiven-app.json
curl "${H[@]}" -X POST $API/project/$PROJECT/service -d @/tmp/aiven-app.json | jq -c '{name:.service.service_name,state:.service.state,error:.message,errors:.errors}'
echo "MELLA_ADMIN_TOKEN=$ADMIN" > "$HOME/.config/mella/aiven-admin.env"
echo "jeton admin dans ~/.config/mella/aiven-admin.env"
