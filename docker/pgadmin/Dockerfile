# Extends official pgAdmin 4 to pre-generate Nebularr DB connections from env at startup.
FROM dpage/pgadmin4:9.9

USER root
COPY docker/pgadmin/bootstrap.py /bootstrap.py
COPY docker/pgadmin/custom-entrypoint.sh /custom-entrypoint.sh
RUN chmod +x /custom-entrypoint.sh

ENTRYPOINT ["/custom-entrypoint.sh"]
