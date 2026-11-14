{{- define "perps.image" -}}
{{ .root.Values.global.imageRegistry }}/{{ .svc.image.repository }}:{{ .svc.image.tag }}
{{- end -}}
{{- define "perps.labels" -}}
app.kubernetes.io/part-of: perps
app.kubernetes.io/name: {{ .name }}
{{- end -}}
{{- define "perps.podsec" -}}
securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: RuntimeDefault } }
{{- end -}}
{{- define "perps.ctrsec" -}}
securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } }
{{- end -}}
