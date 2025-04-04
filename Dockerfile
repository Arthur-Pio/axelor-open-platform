# 1) Fase de build: compila o projeto Axelor
FROM gradle:8.11-jdk11 AS build
WORKDIR /app

COPY . /app

# Dá permissão ao gradlew (se necessário)
RUN chmod +x gradlew

# Build, ignorando testes (ajuste se precisar)
RUN ./gradlew clean build -x check -x test --stacktrace

# 2) Fase de runtime: Tomcat
FROM tomcat:9.0-jdk11
WORKDIR /usr/local/tomcat/webapps

# Copia o WAR gerado na fase de build para a pasta webapps do Tomcat
# Ajuste o nome do WAR conforme o que for gerado em axelor-tomcat/build/libs
COPY --from=build /app/axelor-tomcat/build/libs/axelor-tomcat-*.war ./ROOT.war

EXPOSE 8080

CMD ["catalina.sh", "run"]
