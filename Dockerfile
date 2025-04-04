# 1ª etapa: Build com Gradle e JDK 11
FROM gradle:8.11-jdk11 AS build
WORKDIR /app

# Copia todos os arquivos para dentro do container
COPY . /app

# Garante que o gradlew tem permissão de execução
RUN chmod +x gradlew

# Executa o build ignorando testes e checks (pode demorar um pouco)
RUN ./gradlew clean build -x check -x test --stacktrace

# 2ª etapa: Imagem final com apenas JRE 11
FROM openjdk:11-jre-slim
WORKDIR /app

# COPIE o artefato gerado.
# ATENÇÃO: verifique qual é o arquivo gerado. No exemplo, estamos supondo que o módulo axelor-tomcat gera um arquivo executável,
# por exemplo, um JAR executável dentro de "axelor-tomcat/build/libs".
# Se for WAR e não for executável, talvez seja necessário rodar em um servidor Tomcat.
COPY --from=build /app/axelor-tomcat/build/libs/axelor-tomcat*.jar /app/app.jar

# Expõe a porta (verifique qual porta a aplicação usa – geralmente 8080)
EXPOSE 8080

# Comando para iniciar a aplicação
CMD ["java", "-jar", "/app/app.jar"]
