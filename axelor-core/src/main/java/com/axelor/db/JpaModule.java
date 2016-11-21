/**
 * Axelor Business Solutions
 *
 * Copyright (C) 2005-2016 Axelor (<http://axelor.com>).
 *
 * This program is free software: you can redistribute it and/or  modify
 * it under the terms of the GNU Affero General Public License, version 3,
 * as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package com.axelor.db;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;

import javax.inject.Inject;

import org.hibernate.MultiTenancyStrategy;
import org.hibernate.cfg.Environment;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.axelor.app.AppSettings;
import com.axelor.auth.AuditInterceptor;
import com.axelor.common.ClassUtils;
import com.axelor.common.StringUtils;
import com.axelor.db.internal.DBHelper;
import com.axelor.db.internal.naming.ImplicitNamingStrategyImpl;
import com.axelor.db.internal.naming.PhysicalNamingStrategyImpl;
import com.axelor.db.tenants.TenantConnectionProvider;
import com.axelor.db.tenants.AbstractTenantFilter;
import com.axelor.db.tenants.TenantModule;
import com.axelor.db.tenants.TenantResolver;
import com.google.inject.AbstractModule;
import com.google.inject.persist.PersistService;
import com.google.inject.persist.jpa.JpaPersistModule;

/**
 * A Guice module to configure JPA.
 *
 * This module takes care of initializing JPA and registers an Hibernate custom
 * scanner that automatically scans all the classpath entries for Entity
 * classes.
 *
 */
public class JpaModule extends AbstractModule {

	private static Logger log = LoggerFactory.getLogger(JpaModule.class);

	private String jpaUnit;
	private boolean autoscan;
	private boolean autostart;

	private Properties properties;

	static {
		JpaScanner.exclude("com.axelor.test.db");
		JpaScanner.exclude("com.axelor.web.db");
	}

	/**
	 * Create new instance of the {@link JpaModule} with the given persistence
	 * unit name.
	 *
	 * If <i>autoscan</i> is true then a custom Hibernate scanner will be used to scan
	 * all the classpath entries for Entity classes.
	 *
	 * If <i>autostart</i> is true then the {@link PersistService} will be started
	 * automatically.
	 *
	 * @param jpaUnit
	 *            the persistence unit name
	 * @param autoscan
	 *            whether to enable autoscan
	 * @param autostart
	 *            whether to automatically start persistence service
	 */
	public JpaModule(String jpaUnit, boolean autoscan, boolean autostart) {
		this.jpaUnit = jpaUnit;
		this.autoscan = autoscan;
		this.autostart = autostart;
	}

	/**
	 * Create a new instance of the {@link JpaModule} with the given persistence
	 * unit name with <i>autoscan</i> and <i>autostart</i> enabled.
	 *
	 * @param jpaUnit
	 *            the persistence unit name
	 */
	public JpaModule(String jpaUnit) {
		this(jpaUnit, true, true);
	}

	public JpaModule scan(String pkg) {
		JpaScanner.include(pkg);
		return this;
	}

	/**
	 * Configures the JPA persistence provider with a set of properties.
	 *
	 * @param properties
	 *            A set of name value pairs that configure a JPA persistence
	 *            provider as per the specification.
	 * @return this instance itself
	 */
	public JpaModule properties(final Properties properties) {
		this.properties = properties;
		return this;
	}

	@Override
	protected void configure() {
		log.info("Configuring JPA...");
		Properties properties = new Properties();
		if (this.properties != null) {
			properties.putAll(this.properties);
		}
		if (this.autoscan) {
			properties.put(Environment.SCANNER, JpaScanner.class.getName());
		}

		properties.put(Environment.INTERCEPTOR, AuditInterceptor.class.getName());
		properties.put(Environment.USE_NEW_ID_GENERATOR_MAPPINGS, "true");
		properties.put(Environment.IMPLICIT_NAMING_STRATEGY, ImplicitNamingStrategyImpl.class.getName());
		properties.put(Environment.PHYSICAL_NAMING_STRATEGY, PhysicalNamingStrategyImpl.class.getName());
		
		properties.put(Environment.AUTOCOMMIT, "false");
		properties.put(Environment.MAX_FETCH_DEPTH, "3");

		if (DBHelper.isCacheEnabled()) {
			properties.put(Environment.USE_SECOND_LEVEL_CACHE, "true");
			properties.put(Environment.USE_QUERY_CACHE, "true");
			properties.put(Environment.CACHE_REGION_FACTORY, "org.hibernate.cache.ehcache.EhCacheRegionFactory");
			try {
				updateCacheProperties(properties);
			} catch (Exception e) {
			}
		}
		
		try {
			updatePersistenceProperties(properties);
		} catch (Exception e) {
		}

		install(new TenantModule());
		install(new JpaPersistModule(jpaUnit).properties(properties));
		if (this.autostart) {
			bind(Initializer.class).asEagerSingleton();
		}
		bind(JPA.class).asEagerSingleton();
	}

	private Properties updatePersistenceProperties(Properties properties) {

		final AppSettings settings = AppSettings.get();

		for (String name : settings.getProperties().stringPropertyNames()) {
			if (name.startsWith("hibernate.")) {
				properties.put(name, settings.get(name));
			}
		}

		if (settings.get(AbstractTenantFilter.CONFIG_MULTI_TENANT) != null) {
			properties.put(Environment.MULTI_TENANT, MultiTenancyStrategy.DATABASE.name());
			properties.put(Environment.MULTI_TENANT_CONNECTION_PROVIDER, TenantConnectionProvider.class.getName());
			properties.put(Environment.MULTI_TENANT_IDENTIFIER_RESOLVER, TenantResolver.class.getName());
		}

		if (DBHelper.isDataSourceUsed()) {
			properties.put("hibernate.connection.datasource", DBHelper.getDataSourceName());
			return properties;
		}

		final Map<String, String> keys = new HashMap<>();

		keys.put("db.default.driver", "javax.persistence.jdbc.driver");
		keys.put("db.default.ddl", "hibernate.hbm2ddl.auto");
		keys.put("db.default.url", "javax.persistence.jdbc.url");
		keys.put("db.default.user", "javax.persistence.jdbc.user");
		keys.put("db.default.password", "javax.persistence.jdbc.password");

		for (String key : keys.keySet()) {
			String name = keys.get(key);
			String value = settings.get(key);
			if (!StringUtils.isBlank(value)) {
				properties.put(name, value.trim());
			}
		}
		
		return properties;
	}
	
	private Properties updateCacheProperties(Properties properties) throws IOException {
		final Properties config = new Properties();
		config.load(ClassUtils.getResourceStream("ehcache-objects.properties"));

		for (Object key : config.keySet()) {
			String name = (String) key;
			String value = config.getProperty((String) name).trim();
			String prefix = "hibernate.ejb.classcache";
			if (!Character.isUpperCase(name.charAt(name.lastIndexOf(".") + 1))) {
				prefix = "hibernate.ejb.collectioncache";
			}
			properties.put(prefix + "." + name, value);
		}

		return properties;
	}

	public static class Initializer {

		@Inject
		Initializer(PersistService service) {
			log.info("Initialize JPA...");
			service.start();
		}
	}
}
